/**
 * PolyGerrit UI Renderer & Controller
 * Faithfully recreates Gerrit's Change View, Side-by-Side Diff View,
 * Patchset selector, Yellow Draft Comments, Reply Dialog, and Keyboard Shortcuts.
 */
window.GerritUIRenderer = (() => {
  const { escapeHtml, parseDiff, getFileStatus } = window.GerritDiffParser;

  function timeAgo(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '';
    return new Date(isoStr).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  class GerritApp {
    constructor(container, api, settings, onExitToGitLab) {
      this.container = container;
      this.api = api;
      this.settings = settings;
      this.onExitToGitLab = onExitToGitLab;

      this.storagePrefix = `gr_gitlab_${api.ctx.projectPath}_${api.ctx.mrIid}`;

      this.state = {
        loading: true,
        error: null,
        mr: null,
        versions: [],     // Ordered oldest -> newest (Patchset 1 .. N)
        changes: [],      // Diff files for selected patchset range
        discussions: [],
        commits: [],
        approvals: null,
        currentUser: null,

        basePatchset: 'base',   // 'base' or 1..N
        targetPatchset: null,   // 1..N (latest by default)
        activeTab: 'files',     // 'files' | 'comments' | 'checks'
        commentFilter: 'all',   // 'all' | 'unresolved' | 'drafts'
        showSystemNotes: false,

        viewMode: 'change',     // 'change' | 'diff'
        diffStyle: 'side-by-side', // 'side-by-side' | 'unified'
        selectedFileIndex: 0,
        activeDiffFileIndex: null,
        activeHunkIdx: -1,
        focusedLine: null,      // { side: 'left'|'right', line: number }

        reviewedFiles: this.loadLocal('reviewed', {}),
        drafts: this.loadLocal('drafts', []), // { id, file, oldPath, newPath, side, line, text, createdAt }
        activeInlineEditor: null, // { file, oldPath, newPath, side, line, draftId? }

        replyModalOpen: false,
        shortcutsModalOpen: false,
        editCommitModalOpen: false,
        toast: null,
        darkTheme: settings.theme !== 'light'
      };

      this.boundKeyHandler = this.handleKeyDown.bind(this);
      document.addEventListener('keydown', this.boundKeyHandler);
    }

    destroy() {
      document.removeEventListener('keydown', this.boundKeyHandler);
    }

    loadLocal(key, fallback) {
      try {
        const raw = localStorage.getItem(`${this.storagePrefix}_${key}`);
        return raw ? JSON.parse(raw) : fallback;
      } catch (_) {
        return fallback;
      }
    }

    saveLocal(key, value) {
      try {
        localStorage.setItem(`${this.storagePrefix}_${key}`, JSON.stringify(value));
      } catch (_) {}
    }

    showToast(msg, isError = false) {
      this.state.toast = { msg, isError };
      this.renderToast();
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.state.toast = null;
        this.renderToast();
      }, 3500);
    }

    async init() {
      this.state.loading = true;
      this.state.error = null;
      this.render();

      try {
        const [mr, versionsRaw, changesResp, discussions, commits, approvals, currentUser] =
          await Promise.all([
            this.api.getMergeRequest(),
            this.api.getVersions().catch(() => []),
            this.api.getChanges(),
            this.api.getDiscussions().catch(() => []),
            this.api.getCommits().catch(() => []),
            this.api.getApprovals(),
            this.api.getCurrentUser()
          ]);

        // GitLab returns versions newest-first; Gerrit numbers Patchset 1 = oldest, N = latest
        const versions = Array.isArray(versionsRaw) ? [...versionsRaw].reverse() : [];
        const changes = (changesResp?.changes || []).map((c) => ({
          ...c,
          parsed: parseDiff(c.diff || '')
        }));

        this.state.mr = mr;
        this.state.versions = versions;
        this.state.targetPatchset = versions.length > 0 ? versions.length : 1;
        this.state.basePatchset = 'base';
        this.state.changes = changes;
        this.state.discussions = Array.isArray(discussions) ? discussions : [];
        this.state.commits = Array.isArray(commits) ? commits : [];
        this.state.approvals = approvals;
        this.state.currentUser = currentUser;
        this.state.loading = false;
      } catch (err) {
        this.state.loading = false;
        this.state.error = err;
      }

      this.render();
    }

    async loadPatchsetComparison(baseVal, targetNum) {
      this.state.basePatchset = baseVal;
      this.state.targetPatchset = targetNum;
      this.showToast('Loading patchset diff...');

      try {
        let rawDiffs = [];
        const targetVer = this.state.versions[targetNum - 1];

        if (baseVal === 'base') {
          if (targetVer && targetNum < this.state.versions.length) {
            const detail = await this.api.getVersionDetail(targetVer.id);
            rawDiffs = detail?.diffs || [];
          } else {
            const resp = await this.api.getChanges();
            rawDiffs = resp?.changes || [];
          }
        } else {
          const baseVer = this.state.versions[parseInt(baseVal, 10) - 1];
          if (baseVer && targetVer) {
            const cmp = await this.api.compareShas(baseVer.head_commit_sha, targetVer.head_commit_sha);
            rawDiffs = cmp?.diffs || [];
          }
        }

        this.state.changes = rawDiffs.map((c) => ({
          ...c,
          parsed: parseDiff(c.diff || '')
        }));

        if (this.state.activeDiffFileIndex != null) {
          if (this.state.activeDiffFileIndex >= this.state.changes.length) {
            this.state.activeDiffFileIndex = 0;
          }
        }
        this.render();
      } catch (err) {
        this.showToast(`Failed to load patchset diff: ${err.message}`, true);
      }
    }

    getMrStatus() {
      const mr = this.state.mr;
      if (!mr) return { text: 'Active', cls: 'gr-badge-active' };
      if (mr.state === 'merged') return { text: 'Merged', cls: 'gr-badge-merged' };
      if (mr.state === 'closed') return { text: 'Abandoned', cls: 'gr-badge-abandoned' };
      if (mr.draft || mr.work_in_progress) return { text: 'WIP', cls: 'gr-badge-wip' };
      return { text: 'Active', cls: 'gr-badge-active' };
    }

    getInlineDiscussionsForFile(file) {
      const path = file.new_path || file.old_path;
      const result = [];
      for (const d of this.state.discussions) {
        const firstNote = d.notes?.[0];
        if (!firstNote || firstNote.system || !firstNote.position) continue;
        const pos = firstNote.position;
        if (pos.new_path === path || pos.old_path === path) {
          result.push({
            id: d.id,
            notes: d.notes,
            resolved: d.notes.every((n) => !n.resolvable || n.resolved),
            resolvable: d.notes.some((n) => n.resolvable),
            line: pos.new_line ?? pos.old_line,
            side: pos.new_line != null ? 'right' : 'left'
          });
        }
      }
      return result;
    }

    getUnresolvedCount() {
      let count = 0;
      for (const d of this.state.discussions) {
        if (d.notes?.some((n) => n.resolvable && !n.resolved && !n.system)) {
          count++;
        }
      }
      return count;
    }

    getDraftsForFile(file) {
      const path = file.new_path || file.old_path;
      return this.state.drafts.filter((dr) => dr.file === path);
    }

    toggleReviewed(path) {
      this.state.reviewedFiles[path] = !this.state.reviewedFiles[path];
      this.saveLocal('reviewed', this.state.reviewedFiles);
      this.render();
    }

    saveDraft({ file, oldPath, newPath, side, line, text, draftId }) {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (draftId) {
        const existing = this.state.drafts.find((d) => d.id === draftId);
        if (existing) existing.text = trimmed;
      } else {
        this.state.drafts.push({
          id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          file,
          oldPath,
          newPath,
          side,
          line,
          text: trimmed,
          createdAt: new Date().toISOString()
        });
      }
      this.saveLocal('drafts', this.state.drafts);
      this.state.activeInlineEditor = null;
      this.showToast('Draft saved (press "a" to publish)');
      this.render();
    }

    discardDraft(draftId) {
      this.state.drafts = this.state.drafts.filter((d) => d.id !== draftId);
      this.saveLocal('drafts', this.state.drafts);
      this.state.activeInlineEditor = null;
      this.showToast('Draft discarded');
      this.render();
    }

    async publishReply({ message, vote, selectedDraftIds }) {
      const mr = this.state.mr;
      const draftsToPublish = this.state.drafts.filter((d) => selectedDraftIds.includes(d.id));
      const errors = [];

      // 1. Publish inline drafts
      for (const dr of draftsToPublish) {
        try {
          await this.api.postInlineComment({
            body: dr.text,
            diffRefs: mr.diff_refs,
            oldPath: dr.oldPath,
            newPath: dr.newPath,
            oldLine: dr.side === 'left' ? dr.line : null,
            newLine: dr.side === 'right' ? dr.line : null
          });
          this.state.drafts = this.state.drafts.filter((d) => d.id !== dr.id);
        } catch (e) {
          errors.push(`Draft at ${dr.file}:${dr.line}: ${e.message}`);
        }
      }
      this.saveLocal('drafts', this.state.drafts);

      // 2. Publish top-level summary message
      if (message && message.trim()) {
        try {
          const prefix =
            vote === '+2' ? '**Code-Review +2**\n\n' :
            vote === '-1' ? '**Code-Review -1**\n\n' : '';
          await this.api.postNote(`${prefix}${message.trim()}`);
        } catch (e) {
          errors.push(`Reply message: ${e.message}`);
        }
      }

      // 3. Apply vote (GitLab Approve / Unapprove)
      if (vote === '+2') {
        try {
          await this.api.approve();
        } catch (e) {
          errors.push(`Approve (+2): ${e.message}`);
        }
      } else if (vote === 'unapprove') {
        try {
          await this.api.unapprove();
        } catch (e) {
          errors.push(`Remove approval: ${e.message}`);
        }
      }

      this.state.replyModalOpen = false;
      if (errors.length > 0) {
        this.showToast(`Published with warnings: ${errors[0]}`, true);
      } else {
        this.showToast('Review published');
      }
      await this.init();
    }

    async handleSubmitMr() {
      if (!confirm('Submit (Merge) this Merge Request into ' + this.state.mr.target_branch + '?')) {
        return;
      }
      try {
        await this.api.merge();
        this.showToast('Change submitted (merged)!');
        await this.init();
      } catch (e) {
        this.showToast(`Submit failed: ${e.message}`, true);
      }
    }

    async handleToggleAbandon() {
      const isClosed = this.state.mr.state === 'closed';
      const action = isClosed ? 'Restore (Reopen)' : 'Abandon (Close)';
      if (!confirm(`${action} this change?`)) return;
      try {
        await this.api.updateMergeRequest({ state_event: isClosed ? 'reopen' : 'close' });
        this.showToast(isClosed ? 'Change restored' : 'Change abandoned');
        await this.init();
      } catch (e) {
        this.showToast(`${action} failed: ${e.message}`, true);
      }
    }

    async handleEditCommitMessage(title, description) {
      try {
        await this.api.updateMergeRequest({ title, description });
        this.state.editCommitModalOpen = false;
        this.showToast('Commit message updated');
        await this.init();
      } catch (e) {
        this.showToast(`Update failed: ${e.message}`, true);
      }
    }

    async handleResolveDiscussion(discussionId, resolved) {
      try {
        await this.api.resolveDiscussion(discussionId, resolved);
        this.showToast(resolved ? 'Thread marked resolved' : 'Thread reopened');
        await this.init();
      } catch (e) {
        this.showToast(`Failed: ${e.message}`, true);
      }
    }

    async handleThreadReply(discussionId, body, alsoResolve = false) {
      if (!body.trim()) return;
      try {
        await this.api.replyToDiscussion(discussionId, body.trim());
        if (alsoResolve) {
          await this.api.resolveDiscussion(discussionId, true);
        }
        this.showToast('Reply posted');
        await this.init();
      } catch (e) {
        this.showToast(`Reply failed: ${e.message}`, true);
      }
    }

    openDiffFile(idx) {
      if (idx < 0 || idx >= this.state.changes.length) return;
      this.state.viewMode = 'diff';
      this.state.activeDiffFileIndex = idx;
      this.state.selectedFileIndex = idx;
      this.state.activeHunkIdx = -1;
      this.state.focusedLine = null;
      this.state.activeInlineEditor = null;
      this.render();
      this.container.scrollTop = 0;
    }

    jumpToDiffChunk(delta) {
      const file = this.state.changes[this.state.activeDiffFileIndex];
      if (!file) return;
      const chunks = file.parsed.hunkIndices;
      if (!chunks.length) return;

      let next = this.state.activeHunkIdx + delta;
      if (next < 0) next = 0;
      if (next >= chunks.length) next = chunks.length - 1;
      this.state.activeHunkIdx = next;

      const rowIdx = chunks[next];
      const rowEl = this.container.querySelector(`[data-row-idx="${rowIdx}"]`);
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        rowEl.classList.add('gr-row-flash');
        setTimeout(() => rowEl.classList.remove('gr-row-flash'), 900);
      }
    }

    handleKeyDown(e) {
      // Ignore if Gerrit overlay is hidden
      if (this.container.style.display === 'none') return;

      const tag = document.activeElement?.tagName?.toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;

      if (e.key === 'Escape') {
        if (this.state.replyModalOpen || this.state.shortcutsModalOpen || this.state.editCommitModalOpen || this.state.activeInlineEditor) {
          e.preventDefault();
          this.state.replyModalOpen = false;
          this.state.shortcutsModalOpen = false;
          this.state.editCommitModalOpen = false;
          this.state.activeInlineEditor = null;
          this.render();
        }
        return;
      }

      if (isTyping || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.state.replyModalOpen || this.state.editCommitModalOpen) return;

      if (e.key === '?') {
        e.preventDefault();
        this.state.shortcutsModalOpen = !this.state.shortcutsModalOpen;
        this.render();
        return;
      }

      if (e.key === 'a') {
        e.preventDefault();
        this.state.replyModalOpen = true;
        this.render();
        return;
      }

      if (this.state.viewMode === 'change') {
        if (e.key === 'j') {
          e.preventDefault();
          this.state.selectedFileIndex = Math.min(this.state.changes.length - 1, this.state.selectedFileIndex + 1);
          this.render();
        } else if (e.key === 'k') {
          e.preventDefault();
          this.state.selectedFileIndex = Math.max(0, this.state.selectedFileIndex - 1);
          this.render();
        } else if (e.key === 'Enter' || e.key === 'o') {
          if (this.state.activeTab === 'files' && this.state.changes.length > 0) {
            e.preventDefault();
            this.openDiffFile(this.state.selectedFileIndex);
          }
        } else if (e.key === 'r') {
          const f = this.state.changes[this.state.selectedFileIndex];
          if (f) {
            e.preventDefault();
            this.toggleReviewed(f.new_path || f.old_path);
          }
        }
      } else if (this.state.viewMode === 'diff') {
        if (e.key === 'u') {
          e.preventDefault();
          this.state.viewMode = 'change';
          this.render();
        } else if (e.key === ']') {
          e.preventDefault();
          if (this.state.activeDiffFileIndex < this.state.changes.length - 1) {
            this.openDiffFile(this.state.activeDiffFileIndex + 1);
          } else {
            this.showToast('Last file in change');
          }
        } else if (e.key === '[') {
          e.preventDefault();
          if (this.state.activeDiffFileIndex > 0) {
            this.openDiffFile(this.state.activeDiffFileIndex - 1);
          } else {
            this.showToast('First file in change');
          }
        } else if (e.key === 'n') {
          e.preventDefault();
          this.jumpToDiffChunk(1);
        } else if (e.key === 'p') {
          e.preventDefault();
          this.jumpToDiffChunk(-1);
        } else if (e.key === 'r') {
          const f = this.state.changes[this.state.activeDiffFileIndex];
          if (f) {
            e.preventDefault();
            this.toggleReviewed(f.new_path || f.old_path);
          }
        } else if (e.key === 'c' && this.state.focusedLine) {
          const f = this.state.changes[this.state.activeDiffFileIndex];
          if (f) {
            e.preventDefault();
            this.state.activeInlineEditor = {
              file: f.new_path || f.old_path,
              oldPath: f.old_path,
              newPath: f.new_path,
              side: this.state.focusedLine.side,
              line: this.state.focusedLine.line
            };
            this.render();
          }
        }
      }
    }

    renderToast() {
      let el = this.container.querySelector('.gr-toast');
      if (!this.state.toast) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement('div');
        this.container.appendChild(el);
      }
      el.className = `gr-toast ${this.state.toast.isError ? 'gr-toast-err' : ''}`;
      el.textContent = this.state.toast.msg;
    }

    render() {
      const themeClass = this.state.darkTheme ? 'gr-dark' : 'gr-light';
      this.container.className = `gr-root ${themeClass}`;

      if (this.state.loading) {
        this.container.innerHTML = `
          ${this.renderTopBar()}
          <div class="gr-loading">
            <div class="gr-spinner"></div>
            <div>Loading Merge Request !${escapeHtml(this.api.ctx.mrIid)} into Gerrit View...</div>
          </div>
        `;
        this.bindGlobalEvents();
        return;
      }

      if (this.state.error) {
        this.container.innerHTML = `
          ${this.renderTopBar()}
          <div class="gr-error-card">
            <h2>Could not load GitLab Merge Request data</h2>
            <p class="gr-error-msg">${escapeHtml(this.state.error.message)}</p>
            <p>If your GitLab server blocks browser-session API calls (401/403), click the <strong>Gerrit UI for GitLab</strong> extension icon in Chrome's toolbar and paste a GitLab Personal Access Token (<code>api</code> scope).</p>
            <div class="gr-btn-row">
              <button class="gr-btn gr-btn-primary" id="gr-retry-btn">Retry</button>
              <button class="gr-btn" id="gr-exit-err-btn">Return to GitLab UI</button>
            </div>
          </div>
        `;
        this.bindGlobalEvents();
        this.container.querySelector('#gr-retry-btn')?.addEventListener('click', () => this.init());
        this.container.querySelector('#gr-exit-err-btn')?.addEventListener('click', () => this.onExitToGitLab());
        return;
      }

      const mainHtml =
        this.state.viewMode === 'diff'
          ? this.renderDiffView()
          : this.renderChangeView();

      this.container.innerHTML = `
        ${this.renderTopBar()}
        ${mainHtml}
        ${this.state.replyModalOpen ? this.renderReplyModal() : ''}
        ${this.state.shortcutsModalOpen ? this.renderShortcutsModal() : ''}
        ${this.state.editCommitModalOpen ? this.renderEditCommitModal() : ''}
      `;

      this.bindGlobalEvents();
      this.bindViewEvents();
      this.renderToast();
    }

    renderTopBar() {
      const mr = this.state.mr;
      const draftsCount = this.state.drafts.length;
      return `
        <header class="gr-header">
          <div class="gr-header-left">
            <span class="gr-brand" id="gr-brand-home" title="Back to Change View">
              <span class="gr-brand-icon">G</span>
              <span class="gr-brand-title">Gerrit</span>
            </span>
            <nav class="gr-header-nav">
              <a class="gr-nav-link" href="${escapeHtml(this.api.ctx.origin)}/dashboard/merge_requests">Your Changes</a>
              <a class="gr-nav-link" href="${escapeHtml(this.api.ctx.origin)}/${escapeHtml(this.api.ctx.projectPath)}/-/merge_requests">Open MRs</a>
              <a class="gr-nav-link" href="${escapeHtml(this.api.ctx.origin)}/${escapeHtml(this.api.ctx.projectPath)}">Repo</a>
            </nav>
          </div>
          <div class="gr-header-right">
            ${draftsCount > 0 ? `<span class="gr-draft-pill" id="gr-drafts-pill">${draftsCount} Draft${draftsCount > 1 ? 's' : ''}</span>` : ''}
            <button class="gr-icon-btn" id="gr-shortcuts-btn" title="Keyboard shortcuts (?)">?</button>
            <button class="gr-icon-btn" id="gr-theme-btn" title="Toggle Dark/Light Theme">${this.state.darkTheme ? '☀' : '☾'}</button>
            <button class="gr-btn gr-btn-subtle" id="gr-exit-btn" title="Switch back to native GitLab UI (Shift+G)">GitLab View</button>
          </div>
        </header>
      `;
    }

    renderChangeView() {
      const mr = this.state.mr;
      const status = this.getMrStatus();
      const approvals = this.state.approvals || { approved_by: [] };
      const approvers = approvals.approved_by || [];
      const pipeline = mr.head_pipeline;
      const unresolvedCount = this.getUnresolvedCount();
      const draftsCount = this.state.drafts.length;

      // Verified status from GitLab CI pipeline
      let verifiedBadge = `<span class="gr-vote-none">No CI</span>`;
      if (pipeline) {
        if (pipeline.status === 'success') {
          verifiedBadge = `<span class="gr-vote-pos">+1</span> <a class="gr-link" href="${escapeHtml(pipeline.web_url)}" target="_blank">Pipeline #${pipeline.id}</a>`;
        } else if (pipeline.status === 'failed') {
          verifiedBadge = `<span class="gr-vote-neg">-1</span> <a class="gr-link" href="${escapeHtml(pipeline.web_url)}" target="_blank">Failed #${pipeline.id}</a>`;
        } else {
          verifiedBadge = `<span class="gr-vote-run">${escapeHtml(pipeline.status)}</span> <a class="gr-link" href="${escapeHtml(pipeline.web_url)}" target="_blank">#${pipeline.id}</a>`;
        }
      }

      // Code-Review label from GitLab approvals
      let crBadges = `<span class="gr-vote-none">Need Code-Review</span>`;
      if (approvers.length > 0) {
        crBadges = approvers.map((a) => `
          <span class="gr-voter-row">
            <span class="gr-vote-pos">+2</span>
            <span class="gr-chip">${escapeHtml(a.user?.name || a.user?.username)}</span>
          </span>
        `).join('');
      }

      const reviewers = (mr.reviewers && mr.reviewers.length > 0) ? mr.reviewers : (mr.assignees || []);
      const reviewersHtml = reviewers.length > 0
        ? reviewers.map((u) => {
            const approved = approvers.some((a) => a.user?.id === u.id);
            return `<span class="gr-chip">${escapeHtml(u.name || u.username)}${approved ? ' <strong class="gr-inline-pos">+2</strong>' : ''}</span>`;
          }).join(' ')
        : '<span class="gr-muted">None</span>';

      const labelsHtml = (mr.labels && mr.labels.length > 0)
        ? mr.labels.map((l) => `<span class="gr-topic-chip">${escapeHtml(l)}</span>`).join(' ')
        : '<span class="gr-muted">None</span>';

      const canSubmit = mr.state === 'opened' && !mr.draft && !mr.work_in_progress && !mr.has_conflicts;

      return `
        <div class="gr-subheader">
          <div class="gr-subheader-left">
            <span class="gr-status-badge ${status.cls}">${status.text}</span>
            <span class="gr-change-num" title="GitLab Merge Request !${mr.iid}">${mr.iid}</span>
            <h1 class="gr-subject">${escapeHtml(mr.title)}</h1>
          </div>
          <div class="gr-subheader-actions">
            <button class="gr-btn gr-btn-primary" id="gr-reply-btn" title="Shortcut: a">
              REPLY${draftsCount > 0 ? ` (${draftsCount})` : ''}
            </button>
            ${mr.state === 'opened' ? `
              <button class="gr-btn gr-btn-submit" id="gr-submit-btn" ${canSubmit ? '' : 'title="MR may have conflicts, WIP status, or pending checks"'}>
                SUBMIT
              </button>
            ` : ''}
            ${mr.state !== 'merged' ? `
              <button class="gr-btn" id="gr-abandon-btn">
                ${mr.state === 'closed' ? 'RESTORE' : 'ABANDON'}
              </button>
            ` : ''}
            <button class="gr-btn" id="gr-reload-btn" title="Refresh from GitLab">↻</button>
          </div>
        </div>

        <div class="gr-change-main">
          <div class="gr-change-top-grid">
            <!-- Left Metadata Panel (Classic PolyGerrit) -->
            <section class="gr-metadata-panel">
              <table class="gr-meta-table">
                <tr>
                  <td class="gr-meta-key">Updated</td>
                  <td class="gr-meta-val" title="${escapeHtml(mr.updated_at)}">${timeAgo(mr.updated_at)}</td>
                </tr>
                <tr>
                  <td class="gr-meta-key">Owner</td>
                  <td class="gr-meta-val">
                    <span class="gr-chip">
                      ${mr.author?.avatar_url ? `<img class="gr-avatar" src="${escapeHtml(mr.author.avatar_url)}" alt="">` : ''}
                      ${escapeHtml(mr.author?.name || mr.author?.username || 'Unknown')}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td class="gr-meta-key">Reviewers</td>
                  <td class="gr-meta-val">${reviewersHtml}</td>
                </tr>
                <tr>
                  <td class="gr-meta-key">Repo | Branch</td>
                  <td class="gr-meta-val">
                    <span class="gr-mono">${escapeHtml(this.api.ctx.projectPath)}</span>
                    <span class="gr-muted">|</span>
                    <span class="gr-branch-badge">${escapeHtml(mr.target_branch)}</span>
                    <span class="gr-muted">← ${escapeHtml(mr.source_branch)}</span>
                  </td>
                </tr>
                <tr>
                  <td class="gr-meta-key">Topic / Labels</td>
                  <td class="gr-meta-val">${labelsHtml}</td>
                </tr>
                <tr>
                  <td class="gr-meta-key">Mergeable</td>
                  <td class="gr-meta-val">
                    ${mr.has_conflicts
                      ? '<span class="gr-vote-neg">Merge Conflict</span>'
                      : `<span class="gr-muted">${escapeHtml(mr.detailed_merge_status || mr.merge_status || 'Ready')}</span>`}
                  </td>
                </tr>
              </table>

              <div class="gr-submit-reqs">
                <div class="gr-section-label">Submit Requirements</div>
                <table class="gr-meta-table">
                  <tr>
                    <td class="gr-meta-key">Code-Review</td>
                    <td class="gr-meta-val">${crBadges}</td>
                  </tr>
                  <tr>
                    <td class="gr-meta-key">Verified</td>
                    <td class="gr-meta-val">${verifiedBadge}</td>
                  </tr>
                  <tr>
                    <td class="gr-meta-key">Comments</td>
                    <td class="gr-meta-val">
                      ${unresolvedCount > 0
                        ? `<span class="gr-vote-warn">${unresolvedCount} unresolved</span>`
                        : '<span class="gr-vote-pos">All resolved</span>'}
                    </td>
                  </tr>
                </table>
              </div>
            </section>

            <!-- Center Commit Message Panel -->
            <section class="gr-commit-panel">
              <div class="gr-commit-header">
                <span class="gr-mono gr-muted">
                  Commit ${escapeHtml((mr.sha || mr.diff_refs?.head_sha || '').slice(0, 10))}
                  (Patchset ${this.state.versions.length || 1})
                </span>
                <button class="gr-btn gr-btn-xs" id="gr-edit-msg-btn">EDIT</button>
              </div>
              <pre class="gr-commit-msg">${escapeHtml(mr.title)}${mr.description ? '\n\n' + escapeHtml(mr.description) : ''}\n\nGitLab-MR: !${mr.iid}\nSource-Branch: ${escapeHtml(mr.source_branch)}</pre>
            </section>

            <!-- Right Relation Chain / Commits -->
            <section class="gr-relation-panel">
              <div class="gr-section-label">Commits in MR (${this.state.commits.length})</div>
              <div class="gr-relation-list">
                ${this.state.commits.length > 0
                  ? this.state.commits.map((c) => `
                    <div class="gr-relation-item" title="${escapeHtml(c.id)}">
                      <span class="gr-mono gr-sha">${escapeHtml(c.short_id || c.id?.slice(0, 7))}</span>
                      <span class="gr-rel-title">${escapeHtml(c.title)}</span>
                    </div>
                  `).join('')
                  : '<div class="gr-muted">Single commit</div>'}
              </div>
            </section>
          </div>

          <!-- PolyGerrit Tabs -->
          <div class="gr-tabs-bar">
            <button class="gr-tab ${this.state.activeTab === 'files' ? 'gr-tab-active' : ''}" data-tab="files">
              Files (${this.state.changes.length})
            </button>
            <button class="gr-tab ${this.state.activeTab === 'comments' ? 'gr-tab-active' : ''}" data-tab="comments">
              Comment Threads (${unresolvedCount} unresolved${draftsCount ? `, ${draftsCount} draft` : ''})
            </button>
            <button class="gr-tab ${this.state.activeTab === 'checks' ? 'gr-tab-active' : ''}" data-tab="checks">
              Checks
            </button>
          </div>

          <div class="gr-tab-content">
            ${this.state.activeTab === 'files' ? this.renderFilesTable() : ''}
            ${this.state.activeTab === 'comments' ? this.renderCommentThreadsTab() : ''}
            ${this.state.activeTab === 'checks' ? this.renderChecksTab() : ''}
          </div>

          <!-- Change Log (Always below files, just like Gerrit) -->
          ${this.renderChangeLog()}
        </div>
      `;
    }

    renderPatchsetSelectors() {
      const versions = this.state.versions;
      const total = versions.length || 1;

      let baseOptions = `<option value="base" ${this.state.basePatchset === 'base' ? 'selected' : ''}>Base</option>`;
      for (let i = 1; i < total; i++) {
        baseOptions += `<option value="${i}" ${String(this.state.basePatchset) === String(i) ? 'selected' : ''}>Patchset ${i}</option>`;
      }

      let targetOptions = '';
      for (let i = 1; i <= total; i++) {
        const latestLabel = i === total ? ' (latest)' : '';
        targetOptions += `<option value="${i}" ${Number(this.state.targetPatchset) === i ? 'selected' : ''}>Patchset ${i}${latestLabel}</option>`;
      }

      return `
        <div class="gr-patchset-bar">
          <select class="gr-select" id="gr-base-ps">${baseOptions}</select>
          <span class="gr-muted">→</span>
          <select class="gr-select" id="gr-target-ps">${targetOptions}</select>
        </div>
      `;
    }

    renderFilesTable() {
      const changes = this.state.changes;
      let totalAdd = 0;
      let totalDel = 0;
      let maxDelta = 1;

      changes.forEach((c) => {
        totalAdd += c.parsed.additions;
        totalDel += c.parsed.deletions;
        maxDelta = Math.max(maxDelta, c.parsed.additions + c.parsed.deletions);
      });

      const reviewedCount = changes.filter((c) => this.state.reviewedFiles[c.new_path || c.old_path]).length;

      const rowsHtml = changes.map((file, idx) => {
        const path = file.new_path || file.old_path;
        const status = getFileStatus(file);
        const reviewed = !!this.state.reviewedFiles[path];
        const discussions = this.getInlineDiscussionsForFile(file);
        const unresolved = discussions.filter((d) => !d.resolved).length;
        const drafts = this.getDraftsForFile(file).length;
        const add = file.parsed.additions;
        const del = file.parsed.deletions;
        const addWidth = Math.round((add / maxDelta) * 56);
        const delWidth = Math.round((del / maxDelta) * 56);
        const isSelected = idx === this.state.selectedFileIndex;

        const commentBits = [];
        if (drafts > 0) commentBits.push(`<span class="gr-pill-draft">${drafts} draft</span>`);
        if (unresolved > 0) commentBits.push(`<span class="gr-pill-unresolved">${unresolved} unresolved</span>`);
        else if (discussions.length > 0) commentBits.push(`<span class="gr-pill-resolved">${discussions.length} resolved</span>`);

        return `
          <tr class="gr-file-row ${isSelected ? 'gr-file-selected' : ''} ${reviewed ? 'gr-file-reviewed' : ''}" data-file-idx="${idx}">
            <td class="gr-col-check">
              <input type="checkbox" class="gr-reviewed-cb" data-path="${escapeHtml(path)}" ${reviewed ? 'checked' : ''} title="Mark as reviewed (r)">
            </td>
            <td class="gr-col-status">
              <span class="gr-file-status ${status.cls}" title="${status.label}">${status.code}</span>
            </td>
            <td class="gr-col-path">
              <a href="javascript:void(0)" class="gr-file-link" data-open-idx="${idx}">
                ${file.renamed_file ? `<span class="gr-muted">${escapeHtml(file.old_path)} → </span>` : ''}${escapeHtml(path)}
              </a>
            </td>
            <td class="gr-col-comments">${commentBits.join(' ')}</td>
            <td class="gr-col-delta">
              <span class="gr-delta-add">+${add}</span>, <span class="gr-delta-del">-${del}</span>
            </td>
            <td class="gr-col-bar">
              <div class="gr-size-bar">
                <span class="gr-bar-add" style="width:${addWidth}px"></span>
                <span class="gr-bar-del" style="width:${delWidth}px"></span>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      return `
        <div class="gr-files-toolbar">
          ${this.renderPatchsetSelectors()}
          <div class="gr-files-summary">
            <span class="gr-muted">${reviewedCount}/${changes.length} reviewed</span>
            <span class="gr-muted">•</span>
            <span class="gr-delta-add">+${totalAdd}</span>, <span class="gr-delta-del">-${totalDel}</span>
          </div>
        </div>
        <table class="gr-files-table">
          <thead>
            <tr>
              <th class="gr-col-check">✓</th>
              <th class="gr-col-status">Status</th>
              <th class="gr-col-path">File</th>
              <th class="gr-col-comments">Comments</th>
              <th class="gr-col-delta">Delta</th>
              <th class="gr-col-bar">Size</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="6" class="gr-empty-cell">No file differences in this patchset range.</td></tr>'}
          </tbody>
        </table>
      `;
    }

    renderCommentThreadsTab() {
      const threads = [];
      for (const d of this.state.discussions) {
        const notes = (d.notes || []).filter((n) => !n.system);
        if (!notes.length) continue;
        const first = notes[0];
        const resolved = notes.every((n) => !n.resolvable || n.resolved);
        const resolvable = notes.some((n) => n.resolvable);
        const path = first.position?.new_path || first.position?.old_path || 'General MR Comment';
        const line = first.position?.new_line ?? first.position?.old_line ?? null;
        threads.push({ id: d.id, notes, resolved, resolvable, path, line });
      }

      const filtered = threads.filter((t) => {
        if (this.state.commentFilter === 'unresolved') return !t.resolved;
        if (this.state.commentFilter === 'drafts') return false;
        return true;
      });

      const showDrafts = this.state.commentFilter === 'all' || this.state.commentFilter === 'drafts';

      return `
        <div class="gr-comments-toolbar">
          <button class="gr-pill-btn ${this.state.commentFilter === 'all' ? 'active' : ''}" data-cfilter="all">All (${threads.length + this.state.drafts.length})</button>
          <button class="gr-pill-btn ${this.state.commentFilter === 'unresolved' ? 'active' : ''}" data-cfilter="unresolved">Unresolved (${threads.filter(t => !t.resolved).length})</button>
          <button class="gr-pill-btn ${this.state.commentFilter === 'drafts' ? 'active' : ''}" data-cfilter="drafts">Drafts (${this.state.drafts.length})</button>
        </div>

        <div class="gr-threads-list">
          ${showDrafts ? this.state.drafts.map((dr) => `
            <div class="gr-thread-card gr-card-draft">
              <div class="gr-thread-header">
                <span class="gr-mono gr-thread-loc">${escapeHtml(dr.file)}:${dr.line} (${dr.side})</span>
                <span class="gr-pill-draft">DRAFT</span>
              </div>
              <div class="gr-thread-body">${escapeHtml(dr.text)}</div>
              <div class="gr-thread-actions">
                <button class="gr-btn gr-btn-xs" data-discard-draft="${escapeHtml(dr.id)}">DISCARD</button>
              </div>
            </div>
          `).join('') : ''}

          ${filtered.map((t) => `
            <div class="gr-thread-card ${t.resolved ? 'gr-card-resolved' : 'gr-card-unresolved'}">
              <div class="gr-thread-header">
                <span class="gr-mono gr-thread-loc">
                  ${escapeHtml(t.path)}${t.line ? `:${t.line}` : ''}
                </span>
                <span>
                  ${t.resolvable ? (t.resolved ? '<span class="gr-pill-resolved">Resolved</span>' : '<span class="gr-pill-unresolved">Unresolved</span>') : ''}
                </span>
              </div>
              ${t.notes.map((n) => `
                <div class="gr-note-item">
                  <div class="gr-note-meta">
                    <strong>${escapeHtml(n.author?.name || n.author?.username)}</strong>
                    <span class="gr-muted">${formatDateTime(n.created_at)}</span>
                  </div>
                  <div class="gr-note-body">${escapeHtml(n.body)}</div>
                </div>
              `).join('')}
              <div class="gr-thread-reply-box">
                <input type="text" class="gr-input gr-quick-reply-input" data-disc-id="${escapeHtml(t.id)}" placeholder="Reply to thread...">
                <button class="gr-btn gr-btn-xs gr-quick-reply-send" data-disc-id="${escapeHtml(t.id)}">REPLY</button>
                <button class="gr-btn gr-btn-xs gr-quick-done-btn" data-disc-id="${escapeHtml(t.id)}">DONE</button>
                ${t.resolvable ? `
                  <button class="gr-btn gr-btn-xs gr-toggle-resolve-btn" data-disc-id="${escapeHtml(t.id)}" data-target-resolved="${!t.resolved}">
                    ${t.resolved ? 'REOPEN' : 'RESOLVE'}
                  </button>
                ` : ''}
              </div>
            </div>
          `).join('')}

          ${!filtered.length && (!showDrafts || !this.state.drafts.length) ? '<div class="gr-empty-cell">No matching comment threads.</div>' : ''}
        </div>
      `;
    }

    renderChecksTab() {
      const pipeline = this.state.mr.head_pipeline;
      if (!pipeline) {
        return `<div class="gr-empty-cell">No CI pipeline attached to this Merge Request.</div>`;
      }
      return `
        <div class="gr-checks-card">
          <div class="gr-checks-row">
            <strong>GitLab CI Pipeline #${pipeline.id}</strong>
            <span class="gr-status-badge ${pipeline.status === 'success' ? 'gr-badge-merged' : pipeline.status === 'failed' ? 'gr-badge-neg' : 'gr-badge-active'}">
              ${escapeHtml(pipeline.status)}
            </span>
          </div>
          <div class="gr-muted">Ref: <span class="gr-mono">${escapeHtml(pipeline.ref)}</span> • SHA: <span class="gr-mono">${escapeHtml(pipeline.sha?.slice(0, 10))}</span></div>
          <div style="margin-top:12px;">
            <a class="gr-btn gr-btn-primary" href="${escapeHtml(pipeline.web_url)}" target="_blank">Open Pipeline in GitLab ↗</a>
          </div>
        </div>
      `;
    }

    renderChangeLog() {
      const notes = [];
      for (const d of this.state.discussions) {
        for (const n of (d.notes || [])) {
          if (n.system && !this.state.showSystemNotes) continue;
          if (n.position) continue; // inline comments live in Files / Comment Threads
          notes.push(n);
        }
      }
      notes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      return `
        <section class="gr-changelog">
          <div class="gr-changelog-header">
            <h3>Change Log (${notes.length})</h3>
            <label class="gr-checkbox-label">
              <input type="checkbox" id="gr-show-sys-notes" ${this.state.showSystemNotes ? 'checked' : ''}>
              Show system events
            </label>
          </div>
          <div class="gr-changelog-list">
            ${notes.length > 0 ? notes.map((n) => `
              <div class="gr-log-item ${n.system ? 'gr-log-system' : ''}">
                <div class="gr-log-author">${escapeHtml(n.author?.name || n.author?.username || 'System')}</div>
                <div class="gr-log-body">${escapeHtml(n.body)}</div>
                <div class="gr-log-time" title="${escapeHtml(n.created_at)}">${formatDateTime(n.created_at)}</div>
              </div>
            `).join('') : '<div class="gr-empty-cell">No change messages yet.</div>'}
          </div>
        </section>
      `;
    }

    renderDiffView() {
      const idx = this.state.activeDiffFileIndex;
      const file = this.state.changes[idx];
      if (!file) {
        return `<div class="gr-empty-cell">File not found. <button class="gr-btn" id="gr-back-change-btn">Back to Change</button></div>`;
      }

      const path = file.new_path || file.old_path;
      const reviewed = !!this.state.reviewedFiles[path];
      const inlineDiscussions = this.getInlineDiscussionsForFile(file);
      const fileDrafts = this.getDraftsForFile(file);

      // Map discussions & drafts by side:line
      const commentsByKey = {};
      const addItem = (key, item) => {
        if (!commentsByKey[key]) commentsByKey[key] = [];
        commentsByKey[key].push(item);
      };

      for (const disc of inlineDiscussions) {
        addItem(`${disc.side}:${disc.line}`, { kind: 'discussion', data: disc });
      }
      for (const dr of fileDrafts) {
        addItem(`${dr.side}:${dr.line}`, { kind: 'draft', data: dr });
      }

      const fileOptions = this.state.changes.map((c, i) => {
        const p = c.new_path || c.old_path;
        const mark = this.state.reviewedFiles[p] ? '✓ ' : '';
        return `<option value="${i}" ${i === idx ? 'selected' : ''}>${mark}${escapeHtml(p)} (+${c.parsed.additions}, -${c.parsed.deletions})</option>`;
      }).join('');

      const renderCommentsForLine = (side, line) => {
        if (line == null) return '';
        const key = `${side}:${line}`;
        const items = commentsByKey[key] || [];
        const editor = this.state.activeInlineEditor;
        const hasEditor = editor && editor.file === path && editor.side === side && editor.line === line;

        if (!items.length && !hasEditor) return '';

        let html = '<div class="gr-inline-comments-slot">';
        for (const item of items) {
          if (item.kind === 'draft') {
            const dr = item.data;
            if (hasEditor && editor.draftId === dr.id) continue;
            html += `
              <div class="gr-inline-card gr-card-draft">
                <div class="gr-inline-card-head">
                  <strong>Draft</strong>
                  <span class="gr-muted">Line ${dr.line}</span>
                </div>
                <div class="gr-inline-card-body">${escapeHtml(dr.text)}</div>
                <div class="gr-inline-card-actions">
                  <button class="gr-btn gr-btn-xs" data-edit-draft="${escapeHtml(dr.id)}">EDIT</button>
                  <button class="gr-btn gr-btn-xs" data-discard-draft="${escapeHtml(dr.id)}">DISCARD</button>
                </div>
              </div>
            `;
          } else {
            const disc = item.data;
            html += `
              <div class="gr-inline-card ${disc.resolved ? 'gr-card-resolved' : 'gr-card-unresolved'}">
                ${disc.notes.map((n) => `
                  <div class="gr-inline-note">
                    <div class="gr-inline-card-head">
                      <strong>${escapeHtml(n.author?.name || n.author?.username)}</strong>
                      <span class="gr-muted">${formatDateTime(n.created_at)}</span>
                    </div>
                    <div class="gr-inline-card-body">${escapeHtml(n.body)}</div>
                  </div>
                `).join('')}
                <div class="gr-inline-card-actions">
                  <input type="text" class="gr-input gr-quick-reply-input" data-disc-id="${escapeHtml(disc.id)}" placeholder="Reply...">
                  <button class="gr-btn gr-btn-xs gr-quick-reply-send" data-disc-id="${escapeHtml(disc.id)}">REPLY</button>
                  <button class="gr-btn gr-btn-xs gr-quick-done-btn" data-disc-id="${escapeHtml(disc.id)}">DONE</button>
                  ${disc.resolvable ? `
                    <button class="gr-btn gr-btn-xs gr-toggle-resolve-btn" data-disc-id="${escapeHtml(disc.id)}" data-target-resolved="${!disc.resolved}">
                      ${disc.resolved ? 'REOPEN' : 'RESOLVE'}
                    </button>
                  ` : ''}
                </div>
              </div>
            `;
          }
        }

        if (hasEditor) {
          const existingDraft = editor.draftId ? this.state.drafts.find((d) => d.id === editor.draftId) : null;
          html += `
            <div class="gr-inline-card gr-card-draft gr-inline-editor">
              <div class="gr-inline-card-head">
                <strong>New Draft Comment</strong>
                <span class="gr-muted">${side === 'left' ? 'Base' : 'Patchset'} L${line}</span>
              </div>
              <textarea class="gr-textarea" id="gr-inline-draft-ta" rows="3" placeholder="Type your comment... (Ctrl+Enter to save)">${escapeHtml(existingDraft?.text || '')}</textarea>
              <div class="gr-inline-card-actions">
                <button class="gr-btn gr-btn-primary gr-btn-xs" id="gr-save-inline-draft">SAVE</button>
                <button class="gr-btn gr-btn-xs" id="gr-cancel-inline-draft">CANCEL</button>
              </div>
            </div>
          `;
        }
        html += '</div>';
        return html;
      };

      let diffBodyHtml = '';
      if (this.state.diffStyle === 'side-by-side') {
        const rows = file.parsed.rows.map((r, rIdx) => {
          if (r.type === 'hunk') {
            return `
              <tr class="gr-diff-hunk" data-row-idx="${rIdx}">
                <td colspan="4">${escapeHtml(r.header)}</td>
              </tr>
            `;
          }

          const leftCls = r.type === 'removed' || r.type === 'modified' ? 'gr-code-del' : (r.type === 'added' ? 'gr-code-blank' : '');
          const rightCls = r.type === 'added' || r.type === 'modified' ? 'gr-code-add' : (r.type === 'removed' ? 'gr-code-blank' : '');

          const leftComments = renderCommentsForLine('left', r.leftLine);
          const rightComments = renderCommentsForLine('right', r.rightLine);

          const commentRow = (leftComments || rightComments) ? `
            <tr class="gr-diff-comment-row">
              <td class="gr-ln"></td>
              <td class="gr-comment-cell">${leftComments}</td>
              <td class="gr-ln"></td>
              <td class="gr-comment-cell">${rightComments}</td>
            </tr>
          ` : '';

          return `
            <tr class="gr-diff-row" data-row-idx="${rIdx}">
              <td class="gr-ln ${r.leftLine != null ? 'gr-ln-clickable' : ''}" data-side="left" data-line="${r.leftLine ?? ''}" title="Click to add comment">${r.leftLine ?? ''}</td>
              <td class="gr-code ${leftCls}" data-side="left" data-line="${r.leftLine ?? ''}">${r.leftHtml}</td>
              <td class="gr-ln ${r.rightLine != null ? 'gr-ln-clickable' : ''}" data-side="right" data-line="${r.rightLine ?? ''}" title="Click to add comment">${r.rightLine ?? ''}</td>
              <td class="gr-code ${rightCls}" data-side="right" data-line="${r.rightLine ?? ''}">${r.rightHtml}</td>
            </tr>
            ${commentRow}
          `;
        }).join('');

        diffBodyHtml = `
          <table class="gr-diff-table gr-sbs-table">
            <colgroup>
              <col class="gr-col-ln">
              <col class="gr-col-code">
              <col class="gr-col-ln">
              <col class="gr-col-code">
            </colgroup>
            <tbody>
              ${rows || '<tr><td colspan="4" class="gr-empty-cell">Binary file or empty diff.</td></tr>'}
            </tbody>
          </table>
        `;
      } else {
        // Unified Diff View
        const rows = file.parsed.unifiedRows.map((r, rIdx) => {
          if (r.type === 'hunk') {
            return `<tr class="gr-diff-hunk" data-row-idx="${rIdx}"><td colspan="3">${escapeHtml(r.header)}</td></tr>`;
          }
          const cls = r.type === 'added' ? 'gr-code-add' : (r.type === 'removed' ? 'gr-code-del' : '');
          const side = r.rightLine != null ? 'right' : 'left';
          const line = r.rightLine ?? r.leftLine;
          const comments = renderCommentsForLine(side, line);
          const commentRow = comments ? `
            <tr class="gr-diff-comment-row">
              <td colspan="2" class="gr-ln"></td>
              <td class="gr-comment-cell">${comments}</td>
            </tr>
          ` : '';
          return `
            <tr class="gr-diff-row" data-row-idx="${rIdx}">
              <td class="gr-ln gr-ln-clickable" data-side="left" data-line="${r.leftLine ?? ''}">${r.leftLine ?? ''}</td>
              <td class="gr-ln gr-ln-clickable" data-side="right" data-line="${r.rightLine ?? ''}">${r.rightLine ?? ''}</td>
              <td class="gr-code ${cls}" data-side="${side}" data-line="${line ?? ''}">${r.html}</td>
            </tr>
            ${commentRow}
          `;
        }).join('');

        diffBodyHtml = `
          <table class="gr-diff-table gr-unified-table">
            <colgroup>
              <col class="gr-col-ln">
              <col class="gr-col-ln">
              <col>
            </colgroup>
            <tbody>
              ${rows || '<tr><td colspan="3" class="gr-empty-cell">Binary file or empty diff.</td></tr>'}
            </tbody>
          </table>
        `;
      }

      return `
        <div class="gr-diff-header">
          <div class="gr-diff-header-left">
            <button class="gr-btn" id="gr-back-change-btn" title="Back to Change View (u)">← ${this.state.mr.iid}</button>
            <select class="gr-select gr-file-jump" id="gr-diff-file-select">${fileOptions}</select>
            <button class="gr-btn gr-btn-xs" id="gr-prev-file-btn" ${idx === 0 ? 'disabled' : ''} title="Previous file ([)">◀</button>
            <button class="gr-btn gr-btn-xs" id="gr-next-file-btn" ${idx >= this.state.changes.length - 1 ? 'disabled' : ''} title="Next file (])">▶</button>
          </div>
          <div class="gr-diff-header-right">
            ${this.renderPatchsetSelectors()}
            <label class="gr-checkbox-label gr-reviewed-toggle" title="Shortcut: r">
              <input type="checkbox" id="gr-diff-reviewed-cb" ${reviewed ? 'checked' : ''}>
              Reviewed
            </label>
            <div class="gr-seg-control">
              <button class="gr-seg-btn ${this.state.diffStyle === 'side-by-side' ? 'active' : ''}" data-diff-style="side-by-side">Side-by-Side</button>
              <button class="gr-seg-btn ${this.state.diffStyle === 'unified' ? 'active' : ''}" data-diff-style="unified">Unified</button>
            </div>
            <button class="gr-btn gr-btn-primary" id="gr-reply-btn" title="Shortcut: a">REPLY${this.state.drafts.length ? ` (${this.state.drafts.length})` : ''}</button>
          </div>
        </div>
        <div class="gr-diff-hint">
          Click any line number to add an inline draft comment • Shortcuts: <code>n</code>/<code>p</code> next/prev diff • <code>[</code>/<code>]</code> prev/next file • <code>r</code> mark reviewed • <code>u</code> back to change • <code>a</code> reply
        </div>
        <div class="gr-diff-wrapper">
          ${diffBodyHtml}
        </div>
      `;
    }

    renderReplyModal() {
      const hasApproved = this.state.approvals?.user_has_approved;
      const drafts = this.state.drafts;

      return `
        <div class="gr-modal-backdrop" id="gr-modal-backdrop">
          <div class="gr-modal gr-reply-modal">
            <div class="gr-modal-header">
              <h3>Reply to Change ${this.state.mr.iid}</h3>
              <button class="gr-icon-btn" id="gr-close-modal">✕</button>
            </div>
            <div class="gr-modal-body">
              <textarea id="gr-reply-textarea" class="gr-textarea" rows="4" placeholder="Say something nice..."></textarea>

              <div class="gr-vote-section">
                <div class="gr-vote-row">
                  <span class="gr-vote-label">Code-Review</span>
                  <div class="gr-vote-pills" id="gr-vote-pills">
                    <label class="gr-vote-opt"><input type="radio" name="gr_vote" value="0" checked><span>0</span></label>
                    <label class="gr-vote-opt gr-opt-neg"><input type="radio" name="gr_vote" value="-1"><span>-1</span></label>
                    <label class="gr-vote-opt gr-opt-pos"><input type="radio" name="gr_vote" value="+2"><span>+2 (Approve)</span></label>
                    ${hasApproved ? `<label class="gr-vote-opt"><input type="radio" name="gr_vote" value="unapprove"><span>Remove +2</span></label>` : ''}
                  </div>
                </div>
                <div class="gr-muted gr-vote-note">
                  Note: <code>+2</code> calls GitLab Approve; <code>-1</code> posts a <code>Code-Review -1</code> comment (GitLab has no native negative vote).
                </div>
              </div>

              ${drafts.length > 0 ? `
                <div class="gr-drafts-review">
                  <div class="gr-section-label">Drafts to Publish (${drafts.length})</div>
                  ${drafts.map((dr) => `
                    <label class="gr-draft-check-item">
                      <input type="checkbox" class="gr-publish-draft-cb" value="${escapeHtml(dr.id)}" checked>
                      <div>
                        <div class="gr-mono gr-draft-path">${escapeHtml(dr.file)}:${dr.line}</div>
                        <div class="gr-draft-preview">${escapeHtml(dr.text)}</div>
                      </div>
                    </label>
                  `).join('')}
                </div>
              ` : ''}
            </div>
            <div class="gr-modal-footer">
              <button class="gr-btn" id="gr-cancel-reply">CANCEL</button>
              <button class="gr-btn gr-btn-primary" id="gr-send-reply">SEND</button>
            </div>
          </div>
        </div>
      `;
    }

    renderEditCommitModal() {
      const mr = this.state.mr;
      return `
        <div class="gr-modal-backdrop" id="gr-modal-backdrop">
          <div class="gr-modal">
            <div class="gr-modal-header">
              <h3>Edit Commit Message / MR Description</h3>
              <button class="gr-icon-btn" id="gr-close-modal">✕</button>
            </div>
            <div class="gr-modal-body">
              <label class="gr-field-label">Subject (Title)</label>
              <input type="text" id="gr-edit-title" class="gr-input" value="${escapeHtml(mr.title)}">
              <label class="gr-field-label" style="margin-top:12px;">Description</label>
              <textarea id="gr-edit-desc" class="gr-textarea gr-mono" rows="10">${escapeHtml(mr.description || '')}</textarea>
            </div>
            <div class="gr-modal-footer">
              <button class="gr-btn" id="gr-cancel-edit">CANCEL</button>
              <button class="gr-btn gr-btn-primary" id="gr-save-edit">SAVE</button>
            </div>
          </div>
        </div>
      `;
    }

    renderShortcutsModal() {
      const items = [
        ['a', 'Open Reply dialog (vote & publish drafts)'],
        ['j / k', 'Select next / previous file in Change view'],
        ['Enter / o', 'Open selected file diff'],
        ['u', 'Up to Change view from Diff view'],
        ['[ / ]', 'Previous / Next file in Diff view'],
        ['n / p', 'Next / Previous diff chunk'],
        ['c', 'Add inline draft comment on clicked line'],
        ['r', 'Toggle file as Reviewed'],
        ['Shift + G', 'Toggle between Gerrit UI and native GitLab UI'],
        ['?', 'Show / hide keyboard shortcuts'],
        ['Esc', 'Close dialog / cancel draft']
      ];
      return `
        <div class="gr-modal-backdrop" id="gr-modal-backdrop">
          <div class="gr-modal gr-shortcuts-modal">
            <div class="gr-modal-header">
              <h3>Gerrit Keyboard Shortcuts</h3>
              <button class="gr-icon-btn" id="gr-close-modal">✕</button>
            </div>
            <div class="gr-modal-body">
              <table class="gr-shortcuts-table">
                ${items.map(([k, desc]) => `
                  <tr>
                    <td><kbd class="gr-kbd">${escapeHtml(k)}</kbd></td>
                    <td>${escapeHtml(desc)}</td>
                  </tr>
                `).join('')}
              </table>
            </div>
          </div>
        </div>
      `;
    }

    bindGlobalEvents() {
      this.container.querySelector('#gr-brand-home')?.addEventListener('click', () => {
        this.state.viewMode = 'change';
        this.render();
      });
      this.container.querySelector('#gr-exit-btn')?.addEventListener('click', () => this.onExitToGitLab());
      this.container.querySelector('#gr-shortcuts-btn')?.addEventListener('click', () => {
        this.state.shortcutsModalOpen = true;
        this.render();
      });
      this.container.querySelector('#gr-drafts-pill')?.addEventListener('click', () => {
        this.state.replyModalOpen = true;
        this.render();
      });
      this.container.querySelector('#gr-theme-btn')?.addEventListener('click', () => {
        this.state.darkTheme = !this.state.darkTheme;
        if (chrome?.storage?.sync) {
          chrome.storage.sync.set({ theme: this.state.darkTheme ? 'dark' : 'light' });
        }
        this.render();
      });
    }

    bindViewEvents() {
      // Reply / Submit / Abandon / Reload / Edit msg
      this.container.querySelector('#gr-reply-btn')?.addEventListener('click', () => {
        this.state.replyModalOpen = true;
        this.render();
        setTimeout(() => this.container.querySelector('#gr-reply-textarea')?.focus(), 20);
      });
      this.container.querySelector('#gr-submit-btn')?.addEventListener('click', () => this.handleSubmitMr());
      this.container.querySelector('#gr-abandon-btn')?.addEventListener('click', () => this.handleToggleAbandon());
      this.container.querySelector('#gr-reload-btn')?.addEventListener('click', () => this.init());
      this.container.querySelector('#gr-edit-msg-btn')?.addEventListener('click', () => {
        this.state.editCommitModalOpen = true;
        this.render();
      });

      // Tabs
      this.container.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.state.activeTab = btn.dataset.tab;
          this.render();
        });
      });

      // Comment filter pills
      this.container.querySelectorAll('[data-cfilter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.state.commentFilter = btn.dataset.cfilter;
          this.render();
        });
      });

      // Show system notes
      this.container.querySelector('#gr-show-sys-notes')?.addEventListener('change', (e) => {
        this.state.showSystemNotes = e.target.checked;
        this.render();
      });

      // Patchset selectors
      const baseSel = this.container.querySelector('#gr-base-ps');
      const targetSel = this.container.querySelector('#gr-target-ps');
      if (baseSel && targetSel) {
        const onChange = () => this.loadPatchsetComparison(baseSel.value, parseInt(targetSel.value, 10));
        baseSel.addEventListener('change', onChange);
        targetSel.addEventListener('change', onChange);
      }

      // Files table interactions
      this.container.querySelectorAll('.gr-file-link').forEach((link) => {
        link.addEventListener('click', () => this.openDiffFile(parseInt(link.dataset.openIdx, 10)));
      });
      this.container.querySelectorAll('.gr-file-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('input') || e.target.closest('a')) return;
          this.state.selectedFileIndex = parseInt(row.dataset.fileIdx, 10);
          this.openDiffFile(this.state.selectedFileIndex);
        });
      });
      this.container.querySelectorAll('.gr-reviewed-cb').forEach((cb) => {
        cb.addEventListener('change', () => this.toggleReviewed(cb.dataset.path));
      });

      // Diff View controls
      this.container.querySelector('#gr-back-change-btn')?.addEventListener('click', () => {
        this.state.viewMode = 'change';
        this.render();
      });
      this.container.querySelector('#gr-diff-file-select')?.addEventListener('change', (e) => {
        this.openDiffFile(parseInt(e.target.value, 10));
      });
      this.container.querySelector('#gr-prev-file-btn')?.addEventListener('click', () => {
        this.openDiffFile(this.state.activeDiffFileIndex - 1);
      });
      this.container.querySelector('#gr-next-file-btn')?.addEventListener('click', () => {
        this.openDiffFile(this.state.activeDiffFileIndex + 1);
      });
      this.container.querySelector('#gr-diff-reviewed-cb')?.addEventListener('change', () => {
        const f = this.state.changes[this.state.activeDiffFileIndex];
        if (f) this.toggleReviewed(f.new_path || f.old_path);
      });
      this.container.querySelectorAll('[data-diff-style]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.state.diffStyle = btn.dataset.diffStyle;
          this.render();
        });
      });

      // Line click to open inline draft comment
      this.container.querySelectorAll('.gr-ln-clickable').forEach((cell) => {
        cell.addEventListener('click', () => {
          const line = parseInt(cell.dataset.line, 10);
          if (isNaN(line)) return;
          const side = cell.dataset.side;
          const f = this.state.changes[this.state.activeDiffFileIndex];
          if (!f) return;
          this.state.focusedLine = { side, line };
          this.state.activeInlineEditor = {
            file: f.new_path || f.old_path,
            oldPath: f.old_path,
            newPath: f.new_path,
            side,
            line
          };
          this.render();
          setTimeout(() => this.container.querySelector('#gr-inline-draft-ta')?.focus(), 20);
        });
      });

      // Clicking code focuses line for 'c' shortcut
      this.container.querySelectorAll('.gr-code').forEach((cell) => {
        cell.addEventListener('click', () => {
          const line = parseInt(cell.dataset.line, 10);
          if (!isNaN(line)) {
            this.state.focusedLine = { side: cell.dataset.side, line };
          }
        });
      });

      // Inline draft editor save/cancel
      const inlineTa = this.container.querySelector('#gr-inline-draft-ta');
      const saveInline = () => {
        const ed = this.state.activeInlineEditor;
        if (ed && inlineTa) {
          this.saveDraft({ ...ed, text: inlineTa.value });
        }
      };
      this.container.querySelector('#gr-save-inline-draft')?.addEventListener('click', saveInline);
      this.container.querySelector('#gr-cancel-inline-draft')?.addEventListener('click', () => {
        this.state.activeInlineEditor = null;
        this.render();
      });
      inlineTa?.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          saveInline();
        }
      });

      // Edit / Discard draft buttons
      this.container.querySelectorAll('[data-edit-draft]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const dr = this.state.drafts.find((d) => d.id === btn.dataset.editDraft);
          if (!dr) return;
          this.state.activeInlineEditor = {
            file: dr.file,
            oldPath: dr.oldPath,
            newPath: dr.newPath,
            side: dr.side,
            line: dr.line,
            draftId: dr.id
          };
          this.render();
          setTimeout(() => this.container.querySelector('#gr-inline-draft-ta')?.focus(), 20);
        });
      });
      this.container.querySelectorAll('[data-discard-draft]').forEach((btn) => {
        btn.addEventListener('click', () => this.discardDraft(btn.dataset.discardDraft));
      });

      // Thread quick reply / Done / Resolve
      this.container.querySelectorAll('.gr-quick-reply-send').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.discId;
          const inp = this.container.querySelector(`.gr-quick-reply-input[data-disc-id="${id}"]`);
          if (inp && inp.value.trim()) {
            this.handleThreadReply(id, inp.value, false);
          }
        });
      });
      this.container.querySelectorAll('.gr-quick-done-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.handleThreadReply(btn.dataset.discId, 'Done', true);
        });
      });
      this.container.querySelectorAll('.gr-toggle-resolve-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.handleResolveDiscussion(btn.dataset.discId, btn.dataset.targetResolved === 'true');
        });
      });

      // Modals
      const closeModal = () => {
        this.state.replyModalOpen = false;
        this.state.shortcutsModalOpen = false;
        this.state.editCommitModalOpen = false;
        this.render();
      };
      this.container.querySelector('#gr-close-modal')?.addEventListener('click', closeModal);
      this.container.querySelector('#gr-cancel-reply')?.addEventListener('click', closeModal);
      this.container.querySelector('#gr-cancel-edit')?.addEventListener('click', closeModal);
      this.container.querySelector('#gr-modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'gr-modal-backdrop') closeModal();
      });

      this.container.querySelector('#gr-send-reply')?.addEventListener('click', () => {
        const message = this.container.querySelector('#gr-reply-textarea')?.value || '';
        const vote = this.container.querySelector('input[name="gr_vote"]:checked')?.value || '0';
        const selectedDraftIds = Array.from(
          this.container.querySelectorAll('.gr-publish-draft-cb:checked')
        ).map((cb) => cb.value);
        this.publishReply({ message, vote, selectedDraftIds });
      });

      this.container.querySelector('#gr-save-edit')?.addEventListener('click', () => {
        const title = this.container.querySelector('#gr-edit-title')?.value || '';
        const desc = this.container.querySelector('#gr-edit-desc')?.value || '';
        if (title.trim()) this.handleEditCommitMessage(title.trim(), desc);
      });
    }
  }

  return { GerritApp };
})();
