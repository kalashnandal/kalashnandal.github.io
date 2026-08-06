/* ============================================================================
   xlsx.js — a minimal, dependency-free .xlsx writer.

   Why not a library? This dashboard is a static page on GitHub Pages, and the
   export is the one feature that absolutely has to work: it is the only
   sanctioned way data leaves the system. Pulling a spreadsheet library off a
   CDN at click time means the export breaks whenever an office network blocks
   the CDN or the CDN has a bad day. Everything needed here is a flat grid of
   strings and numbers, which is a small enough slice of OOXML to just write.

   An .xlsx is a ZIP of XML parts. Entries are STORED (no compression) so no
   deflate implementation is needed — the files are small and Excel does not
   care.

   Produces: bold frozen header row, column widths, an autofilter, real
   numeric cells, and one tab per sheet.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   XML helpers
--------------------------------------------------------------------------- */

/* XML 1.0 forbids most control characters outright — they cannot be escaped,
   only removed, and a stray one makes the whole file unopenable. */
const stripBad = (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

const xml = (s) =>
  stripBad(String(s)).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

/* 0 -> A, 25 -> Z, 26 -> AA … */
export function colName(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

/* ---------------------------------------------------------------------------
   CRC32 — required by the ZIP container
--------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------------------
   ZIP writer (STORED entries only)
--------------------------------------------------------------------------- */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  // DOS time/date. Excel ignores these; a fixed timestamp keeps output stable.
  const time = 0, date = ((2020 - 1980) << 9) | (1 << 5) | 1;

  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const body = typeof data === "string" ? enc.encode(data) : data;
    const crc = crc32(body);

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), nameBytes, body);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ]);
    central.push(nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const arr = c instanceof Uint8Array ? c : new Uint8Array(c);
    cdParts.push(arr);
    cdSize += arr.length;
  }

  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);

  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of [...parts, ...cdParts, end]) { out.set(a, p); p += a.length; }
  return out;
}

/* ---------------------------------------------------------------------------
   Sheet XML
--------------------------------------------------------------------------- */
function sheetXml(aoa, cols) {
  const rowCount = aoa.length;
  const colCount = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const dim = `A1:${colName(Math.max(colCount - 1, 0))}${Math.max(rowCount, 1)}`;

  const colsXml = cols?.length
    ? `<cols>${cols.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 14}" customWidth="1"/>`).join("")}</cols>`
    : "";

  const rows = aoa.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : "";
      if (v === null || v === undefined || v === "") return `<c r="${ref}"${style}/>`;
      if (typeof v === "number" && Number.isFinite(v)) {
        return `<c r="${ref}"${style}><v>${v}</v></c>`;
      }
      // Inline strings keep the file to one part per sheet — no shared string table.
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");

  // Freeze the header row, and put an autofilter on it when there is data.
  const pane = rowCount > 1
    ? `<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`;

  const filter = rowCount > 1 && colCount > 0
    ? `<autoFilter ref="A1:${colName(colCount - 1)}${rowCount}"/>`
    : "";

  /* Element order below follows the CT_Worksheet sequence — Excel rejects the
     file if these are out of order. */
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetViews>${pane}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/* Excel limits sheet names to 31 chars and forbids : \ / ? * [ ] */
const safeSheetName = (n, i) =>
  (String(n || `Sheet${i + 1}`).replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31)) || `Sheet${i + 1}`;

/* ---------------------------------------------------------------------------
   PUBLIC API

   sheets: [{ name, aoa, cols }]
     aoa  — array of rows, each an array of strings / numbers. Row 0 is the
            header and is styled bold and frozen.
     cols — optional array of column widths (characters).
--------------------------------------------------------------------------- */
export function buildXlsx(sheets) {
  const names = sheets.map((s, i) => safeSheetName(s.name, i));

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      }<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
        names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      }</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      }<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s.aoa || [], s.cols),
    })),
  ];

  return zip(files);
}

/* Build the workbook and hand it to the browser as a download. */
export function downloadXlsx(sheets, filename) {
  const bytes = buildXlsx(sheets);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
