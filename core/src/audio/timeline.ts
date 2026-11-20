/**
 * `aresample` options that put decoded audio on the container (picture) timeline: silence fills a late
 * audio start (first_pts=0) and any timestamp gap over 10 ms (phone recordings drop audio packets at the
 * start), so sample N plays at N / rate seconds from the start of the video. Every step that reads the
 * source audio uses it, so word times, cut ranges, the mix and the picture all agree.
 */
export const CONTAINER_TIMELINE = "async=1:min_hard_comp=0.01:first_pts=0";
