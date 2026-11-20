/**
 * Reads the markdown report the Check step writes (renders/qa.md) into plain data, so the view can show it
 * as a panel. Only the shapes qa.md uses are understood (bullets, tables, quotes, one image); every value
 * stays plain text and is never turned into HTML.
 */

export type QaLevel = "pass" | "warn" | "fail" | "info" | "skipped";

export type QaReport = {
  facts: { label: string; value: string }[];
  measured: { check: string; value: string; level: QaLevel; detail: string }[];
  notes: { text: string; fail: boolean }[];
  contactSheet?: { file: string; caption: string };
  rubric: { item: string; target: string; score: string }[];
};

const LEVELS: QaLevel[] = ["pass", "warn", "fail", "info", "skipped"];

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Table body rows under a header row; the separator row (| --- |) is skipped. */
function tableRows(lines: string[]): string[][] {
  const rows = lines.filter((l) => l.trim().startsWith("|") && !/^[\s|:-]+$/.test(l)).map(cells);
  return rows.slice(1);
}

export function parseQaReport(md: string): QaReport {
  const report: QaReport = { facts: [], measured: [], notes: [], rubric: [] };
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of md.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      current = heading[1]!.trim().toLowerCase();
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)!.push(line);

    const fact = /^\s*-\s+([^:]+):\s*(.*)$/.exec(line);
    if (fact) report.facts.push({ label: fact[1]!.trim(), value: fact[2]!.trim() });
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const text = quote[1]!.trim().replace(/^Note:\s*/i, "");
      if (text) report.notes.push({ text: text.charAt(0).toUpperCase() + text.slice(1), fail: /^FAIL\b/.test(text) });
    }
    const image = /!\[[^\]]*\]\(([^)\s]+)\)(.*)$/.exec(line);
    if (image && !report.contactSheet) {
      const frames = /(\d+)\s+frames/.exec(image[2] ?? "");
      report.contactSheet = { file: image[1]!, caption: frames ? `${frames[1]} frames` : "" };
    }
  }

  for (const [name, lines] of sections) {
    if (name.startsWith("measured")) {
      for (const [check = "", value = "", result = ""] of tableRows(lines)) {
        const word = result.split(/[\s:]/)[0]!.toLowerCase();
        const level = (LEVELS as string[]).includes(word) ? (word as QaLevel) : "info";
        const detail = result.includes(":") ? result.slice(result.indexOf(":") + 1).trim() : "";
        // "Black opening (blackStartSec)": the metric's code name in brackets means nothing to a reader.
        report.measured.push({ check: check.replace(/\s*\([a-z][A-Za-z]*\)$/, ""), value, level, detail });
      }
    } else if (name.startsWith("rubric")) {
      for (const [item = "", target = "", score = ""] of tableRows(lines)) report.rubric.push({ item, target, score });
    }
  }
  return report;
}

/**
 * Project-relative path of a file a report links to, when it is a plain image file name in the report's own
 * folder ("contact-sheet.jpg" next to "renders/qa.md"). Anything else (a folder, "..", a URL) gives undefined.
 */
export function siblingPath(reportPath: string, file: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp)$/i.test(file)) return undefined;
  const slash = reportPath.lastIndexOf("/");
  return slash === -1 ? file : `${reportPath.slice(0, slash + 1)}${file}`;
}
