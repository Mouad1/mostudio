#!/bin/bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: $0 <new-output-directory>" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Build requires a native Apple Silicon Mac." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$repo_root/packaging/ffmpeg-sources.tsv"
output="$1"
if [[ -e "$output" || -L "$output" ]]; then
  echo "Output already exists: $output" >&2
  exit 2
fi
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
cache="${MOSTUDIO_FFMPEG_CACHE:-${TMPDIR:-/tmp}/mostudio-ffmpeg-cache}"
mkdir -p "$cache"
cache="$(cd "$cache" && pwd)"
work="$(mktemp -d /tmp/mostudio-ffmpeg-build.XXXXXX)"
trap 'if [[ "${MOSTUDIO_KEEP_FFMPEG_BUILD:-0}" == 1 ]]; then echo "Build work: $work" >&2; else rm -rf "$work"; fi' EXIT
prefix="$work/prefix"
sources="$work/sources"
bundle="$work/bundle"
jobs="${MOSTUDIO_FFMPEG_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
mkdir -p "$sources" "$prefix/lib/pkgconfig" "$bundle/bin" "$bundle/LICENSES"

export MACOSX_DEPLOYMENT_TARGET=12.0
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CC="$(xcrun --find clang)"
export CXX="$(xcrun --find clang++)"
export CFLAGS="-O2 -ffile-prefix-map=$work=/mostudio-build"
export CXXFLAGS="$CFLAGS"
export PKG_CONFIG="$work/tools/bin/pkgconf"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=
export SOURCE_DATE_EPOCH=0
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH CPPFLAGS LDFLAGS

while IFS=$'\t' read -r filename expected url; do
  [[ "$filename" =~ ^[A-Za-z0-9._+-]+$ && "$expected" =~ ^[a-f0-9]{64}$ && "$url" == https://* ]]
  archive="$cache/$filename"
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --silent --show-error --proto '=https' --retry 2 "$url" -o "$work/download"
    printf '%s  %s\n' "$expected" "$work/download" | shasum -a 256 -c
    mv "$work/download" "$archive"
  fi
  printf '%s  %s\n' "$expected" "$archive" | shasum -a 256 -c
  component="${filename%%-*}"
  mkdir "$sources/$component"
  tar -xf "$archive" -C "$sources/$component" --strip-components=1
done < "$manifest"

configure_static() {
  ./configure --prefix="$prefix" --enable-static --disable-shared "$@"
}

echo "Building pkgconf"
(
  cd "$sources/pkgconf"
  ./configure --prefix="$work/tools" --enable-static --disable-shared
  make -j "$jobs"
  make install
)

echo "Building FreeType"
(
  cd "$sources/freetype"
  configure_static --without-zlib --without-bzip2 --without-png --without-harfbuzz --without-brotli
  make -j "$jobs"
  make install
)

echo "Building HarfBuzz"
cmake -S "$sources/harfbuzz" -B "$work/harfbuzz" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH="$prefix" -DCMAKE_OSX_ARCHITECTURES=arm64 \
  '-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local' -DBUILD_SHARED_LIBS=OFF \
  -DHB_HAVE_FREETYPE=ON -DHB_HAVE_CORETEXT=OFF -DHB_BUILD_UTILS=OFF \
  -DHB_BUILD_SUBSET=OFF -DHB_BUILD_RASTER=OFF -DHB_BUILD_VECTOR=OFF -DHB_BUILD_GPU=OFF
cmake --build "$work/harfbuzz" --parallel "$jobs"
cmake --install "$work/harfbuzz"

echo "Building FriBidi"
(
  cd "$sources/fribidi"
  configure_static --disable-docs
  make -j "$jobs" -C gen.tab
  make -j "$jobs" -C lib
  make -C lib install
  install -m 644 fribidi.pc "$prefix/lib/pkgconfig/"
)

echo "Building libass"
(
  cd "$sources/libass"
  configure_static --disable-fontconfig --disable-libunibreak
  make -j "$jobs"
  make install
)

echo "Building x264"
(
  cd "$sources/x264"
  ./configure --prefix="$prefix" --enable-static --disable-cli --disable-opencl \
    --disable-lsmash --disable-swscale --disable-ffms
  make -j "$jobs"
  make install
)

echo "Building LAME"
(
  cd "$sources/lame"
  CFLAGS="$CFLAGS -std=gnu17 -Wno-implicit-function-declaration" \
    configure_static --disable-frontend --disable-decoder
  make -j "$jobs"
  make install
)

echo "Building zimg"
# Build just the upstream library sources for this architecture, without Autotools.
cat > "$sources/zimg/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.15)
project(mostudio_zimg LANGUAGES CXX)
file(GLOB_RECURSE files CONFIGURE_DEPENDS "src/zimg/*.cpp")
list(FILTER files EXCLUDE REGEX "/x86/")
add_library(zimg STATIC ${files})
target_include_directories(zimg PRIVATE src/zimg)
target_compile_features(zimg PRIVATE cxx_std_14)
target_compile_definitions(zimg PRIVATE ZIMG_ARM)
install(TARGETS zimg ARCHIVE DESTINATION lib)
install(FILES src/zimg/api/zimg.h src/zimg/api/zimg++.hpp DESTINATION include)
CMAKE
cmake -S "$sources/zimg" -B "$work/zimg" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build "$work/zimg" --parallel "$jobs"
cmake --install "$work/zimg"
sed -e "s|@prefix@|$prefix|" -e 's|@exec_prefix@|${prefix}|' \
  -e 's|@libdir@|${exec_prefix}/lib|' -e 's|@includedir@|${prefix}/include|' \
  -e 's|@VERSION@|3.0.6|' -e 's|@STL_LIBS@|-lc++|' "$sources/zimg/zimg.pc.in" > "$prefix/lib/pkgconfig/zimg.pc"

echo "Building FFmpeg"
(
  cd "$sources/ffmpeg"
  CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib" ./configure \
    --disable-autodetect --disable-network --disable-debug --disable-doc --disable-ffplay \
    --enable-gpl --enable-version3 --enable-static --disable-shared \
    --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-bzlib --enable-iconv \
    --enable-libass --enable-libx264 --enable-libmp3lame --enable-libzimg \
    --pkg-config="$PKG_CONFIG" --pkg-config-flags=--static --extra-libs=-lc++
  make -j "$jobs" ffmpeg ffprobe
  install -m 755 ffmpeg ffprobe "$bundle/bin/"
)

license() {
  local component="$1" path="$2"
  cp "$sources/$component/$path" "$bundle/LICENSES/$component-$(basename "$path")"
}
license ffmpeg COPYING.GPLv3
license ffmpeg COPYING.GPLv2
license ffmpeg COPYING.LGPLv3
license ffmpeg COPYING.LGPLv2.1
license ffmpeg LICENSE.md
license freetype LICENSE.TXT
license freetype docs/FTL.TXT
license freetype docs/GPLv2.TXT
license harfbuzz COPYING
license fribidi COPYING
license libass COPYING
license x264 COPYING
license lame COPYING
license lame LICENSE
license zimg COPYING
license pkgconf COPYING

for binary in ffmpeg ffprobe; do
  deps="$(otool -L "$bundle/bin/$binary" | tail -n +2 | awk '{print $1}')"
  if printf '%s\n' "$deps" | grep -Ev '^(/usr/lib/|/System/Library/)' >&2; then
    echo "Unexpected non-system dependency in $binary." >&2
    exit 1
  fi
done

source_bundle="$work/mostudio-ffmpeg-source"
mkdir -p "$source_bundle/scripts" "$source_bundle/packaging" "$source_bundle/archives"
cp "$0" "$source_bundle/scripts/build-ffmpeg-mac.sh"
cp "$manifest" "$source_bundle/packaging/ffmpeg-sources.tsv"
cp -R "$bundle/LICENSES" "$source_bundle"
while IFS=$'\t' read -r filename _; do
  cp "$cache/$filename" "$source_bundle/archives/"
done < "$manifest"
cat > "$source_bundle/README.txt" <<'README'
Build this source with Xcode and CMake on an Apple Silicon Mac:

  MOSTUDIO_FFMPEG_CACHE="$PWD/archives" bash scripts/build-ffmpeg-mac.sh ./built

The script verifies all archives before use. It targets macOS 12 and embeds
static copies of FreeType, HarfBuzz, FriBidi, libass, x264, LAME, and zimg.
pkgconf is a build tool. zimg's local CMake recipe is in the build script.
See LICENSES for the full upstream notices.
README
printf '%s\n' "$(xcodebuild -version)" "$("$CC" --version | head -n 1)" "$(cmake --version | head -n 1)" > "$source_bundle/toolchain.txt"
COPYFILE_DISABLE=1 tar -czf "$bundle/ffmpeg-corresponding-source.tar.gz" -C "$work" mostudio-ffmpeg-source
(
  cd "$bundle"
  shasum -a 256 bin/ffmpeg bin/ffprobe ffmpeg-corresponding-source.tar.gz LICENSES/* > SHA256SUMS
)
mv "$bundle" "$output"
echo "Built controlled FFmpeg runtime: $output"
