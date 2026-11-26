/**
 * Unified Diff Parser with Side-by-Side alignment & Intraline word-diff highlighting
 * Recreates PolyGerrit's diff presentation from GitLab unified diff strings.
 */
window.GerritDiffParser = (() => {
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Compute lightweight intraline diff highlighting between an old and new line.
   * Uses common prefix & suffix trimming for fast, deterministic PolyGerrit-style highlights.
   */
  function computeIntraline(oldText, newText) {
    if (oldText === newText) {
      return {
        leftHtml: escapeHtml(oldText),
        rightHtml: escapeHtml(newText)
      };
    }
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < (minLen - prefixLen) &&
      oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const oldPrefix = oldText.slice(0, prefixLen);
    const oldMid = oldText.slice(prefixLen, oldText.length - suffixLen);
    const oldSuffix = suffixLen > 0 ? oldText.slice(oldText.length - suffixLen) : '';

    const newPrefix = newText.slice(0, prefixLen);
    const newMid = newText.slice(prefixLen, newText.length - suffixLen);
    const newSuffix = suffixLen > 0 ? newText.slice(newText.length - suffixLen) : '';

    const leftHtml =
      escapeHtml(oldPrefix) +
      (oldMid ? `<span class="gr-intraline-del">${escapeHtml(oldMid)}</span>` : '') +
      escapeHtml(oldSuffix);

    const rightHtml =
      escapeHtml(newPrefix) +
      (newMid ? `<span class="gr-intraline-add">${escapeHtml(newMid)}</span>` : '') +
      escapeHtml(newSuffix);

    return { leftHtml, rightHtml };
  }

  /**
   * Parse GitLab unified diff string into stats + structured side-by-side & unified rows.
   */
  function parseDiff(diffText) {
    const result = {
      additions: 0,
      deletions: 0,
      rows: [],        // Side-by-side rows
      unifiedRows: [], // Unified rows
      hunkIndices: []  // Row indices where changes start (for n/p navigation)
    };

    if (!diffText || !diffText.trim()) {
      return result;
    }

    const lines = diffText.split('\n');
    let oldLine = 0;
    let newLine = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Hunk header
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[3], 10);
        result.rows.push({
          type: 'hunk',
          header: line,
          context: hunkMatch[5] ? hunkMatch[5].trim() : ''
        });
        result.unifiedRows.push({
          type: 'hunk',
          header: line
        });
        i++;
        continue;
      }

      // Skip diff metadata lines
      if (line.startsWith('\\ No newline at end of file')) {
        i++;
        continue;
      }

      // Context line
      if (line.startsWith(' ')) {
        const text = line.slice(1);
        result.rows.push({
          type: 'context',
          leftLine: oldLine,
          rightLine: newLine,
          leftHtml: escapeHtml(text),
          rightHtml: escapeHtml(text)
        });
        result.unifiedRows.push({
          type: 'context',
          leftLine: oldLine,
          rightLine: newLine,
          html: escapeHtml(text)
        });
        oldLine++;
        newLine++;
        i++;
        continue;
      }

      // Collect contiguous block of deletions followed by additions to pair them side-by-side
      if (line.startsWith('-') || line.startsWith('+')) {
        const dels = [];
        const adds = [];

        while (i < lines.length && lines[i].startsWith('-')) {
          const text = lines[i].slice(1);
          dels.push({ line: oldLine, text });
          result.unifiedRows.push({
            type: 'removed',
            leftLine: oldLine,
            rightLine: null,
            html: escapeHtml(text)
          });
          oldLine++;
          result.deletions++;
          i++;
        }

        while (i < lines.length && lines[i].startsWith('+')) {
          const text = lines[i].slice(1);
          adds.push({ line: newLine, text });
          result.unifiedRows.push({
            type: 'added',
            leftLine: null,
            rightLine: newLine,
            html: escapeHtml(text)
          });
          newLine++;
          result.additions++;
          i++;
        }

        result.hunkIndices.push(result.rows.length);

        const maxLen = Math.max(dels.length, adds.length);
        for (let k = 0; k < maxLen; k++) {
          const d = dels[k];
          const a = adds[k];
          if (d && a) {
            const intra = computeIntraline(d.text, a.text);
            result.rows.push({
              type: 'modified',
              leftLine: d.line,
              rightLine: a.line,
              leftHtml: intra.leftHtml,
              rightHtml: intra.rightHtml
            });
          } else if (d) {
            result.rows.push({
              type: 'removed',
              leftLine: d.line,
              rightLine: null,
              leftHtml: escapeHtml(d.text),
              rightHtml: ''
            });
          } else if (a) {
            result.rows.push({
              type: 'added',
              leftLine: null,
              rightLine: a.line,
              leftHtml: '',
              rightHtml: escapeHtml(a.text)
            });
          }
        }
        continue;
      }

      i++;
    }

    return result;
  }

  function getFileStatus(change) {
    if (change.new_file) return { code: 'A', label: 'Added', cls: 'gr-status-a' };
    if (change.deleted_file) return { code: 'D', label: 'Deleted', cls: 'gr-status-d' };
    if (change.renamed_file) return { code: 'R', label: 'Renamed', cls: 'gr-status-r' };
    return { code: 'M', label: 'Modified', cls: 'gr-status-m' };
  }

  return {
    escapeHtml,
    parseDiff,
    getFileStatus
  };
})();
