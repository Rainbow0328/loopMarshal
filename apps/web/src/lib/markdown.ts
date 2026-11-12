/**
 * Lightweight Markdown to HTML renderer.
 * Supports: headings, bold, italic, inline code, code blocks, links,
 * lists (ordered/unordered), blockquotes, tables, horizontal rules.
 * Output is safe — all user content is escaped before applying formatting.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
  // Parse raw tokens before escaping; formatting inside URLs must never create attributes.
  const tokens =
    /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w)/g;
  let result = "";
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    result += escapeHtml(text.slice(end, match.index));
    if (match[1] !== undefined)
      result += `<code class="md-inline-code">${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) {
      const label = renderInline(match[2]);
      const url = match[3];
      result +=
        /^(https?:\/\/|mailto:|\/(?![\/\\])|#)/i.test(url) &&
        !/[\u0000-\u001f\u007f]/.test(url)
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`
          : label;
    } else if (match[4] !== undefined || match[5] !== undefined)
      result += `<strong>${renderInline(match[4] ?? match[5])}</strong>`;
    else result += `<em>${renderInline(match[6] ?? match[7])}</em>`;
    end = match.index! + match[0].length;
  }
  return result + escapeHtml(text.slice(end));
}

export function renderMarkdown(md: string): string {
  if (!md) return "<p>无文档内容</p>";

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBuffer: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listBuffer: string[] = [];
  let inTable = false;
  let tableHeader: string[] = [];
  let tableRows: string[][] = [];

  const flushList = () => {
    if (listType && listBuffer.length > 0) {
      const tag = listType;
      html.push(
        `<${tag}>${listBuffer.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
      );
      listBuffer = [];
      listType = null;
    }
  };

  const flushTable = () => {
    if (inTable && tableRows.length > 0) {
      let table = '<div class="md-table-wrap"><table class="md-table">';
      if (tableHeader.length > 0) {
        table += "<thead><tr>";
        table += tableHeader.map((h) => `<th>${renderInline(h)}</th>`).join("");
        table += "</tr></thead>";
      }
      table += "<tbody>";
      table += tableRows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
        )
        .join("");
      table += "</tbody></table></div>";
      html.push(table);
      tableHeader = [];
      tableRows = [];
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fences
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        flushList();
        flushTable();
        inCodeBlock = true;
        codeBlockLang = line
          .trim()
          .slice(3)
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, "");
        codeBuffer = [];
      } else {
        const code = escapeHtml(codeBuffer.join("\n"));
        html.push(
          `<pre class="md-code-block${codeBlockLang ? ` lang-${codeBlockLang}` : ""}"><code>${code}</code></pre>`,
        );
        inCodeBlock = false;
        codeBlockLang = "";
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Table detection (line with | and next line with |---|---|)
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|/.test(lines[i + 1])
    ) {
      flushList();
      inTable = true;
      tableHeader = line
        .split("|")
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
      i++; // skip separator line
      continue;
    }

    if (inTable) {
      if (line.includes("|")) {
        const cells = line
          .split("|")
          .map((c) => c.trim())
          .filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
        tableRows.push(cells);
        continue;
      } else {
        flushTable();
      }
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      flushList();
      html.push('<hr class="md-hr" />');
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      html.push(
        `<h${level} class="md-heading md-h${level}">${renderInline(headingMatch[2])}</h${level}>`,
      );
      continue;
    }

    // Blockquote
    if (line.trim().startsWith(">")) {
      flushList();
      const content = line.trim().replace(/^>\s?/, "");
      html.push(
        `<blockquote class="md-blockquote">${renderInline(content)}</blockquote>`,
      );
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listBuffer.push(olMatch[2]);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listBuffer.push(ulMatch[2]);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      flushList();
      flushTable();
      continue;
    }

    // Regular paragraph
    flushList();
    flushTable();
    html.push(`<p class="md-paragraph">${renderInline(line)}</p>`);
  }

  // Flush remaining
  if (inCodeBlock) {
    html.push(
      `<pre class="md-code-block"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`,
    );
  }
  flushList();
  flushTable();

  return html.join("\n");
}
