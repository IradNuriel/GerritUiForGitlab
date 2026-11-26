/**
 * GitLab REST API v4 Client for Gerrit UI Overlay.
 * Uses the active browser session (cookies + CSRF token) automatically,
 * with optional Personal Access Token override from extension settings.
 */
window.GitLabApiClient = (() => {
  function detectMrContext() {
    const pathname = window.location.pathname;
    // Matches both /group/project/-/merge_requests/123 and /group/project/merge_requests/123
    const match = pathname.match(/^\/(.+?)(?:\/-)?\/merge_requests\/(\d+)(?:\/.*)?$/);
    if (!match) return null;

    const projectPath = match[1];
    const mrIid = match[2];

    // Try to detect numeric project ID from GitLab DOM if available
    const projectIdAttr =
      document.body?.dataset?.projectId ||
      document.querySelector('[data-project-id]')?.getAttribute('data-project-id');

    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

    return {
      origin: window.location.origin,
      projectPath,
      projectRef: projectIdAttr && /^\d+$/.test(projectIdAttr)
        ? projectIdAttr
        : encodeURIComponent(projectPath),
      mrIid,
      csrfToken
    };
  }

  class Client {
    constructor(ctx, pat = '') {
      this.ctx = ctx;
      this.pat = pat ? pat.trim() : '';
      this.baseUrl = `${ctx.origin}/api/v4/projects/${ctx.projectRef}`;
    }

    async request(path, options = {}) {
      const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
      const headers = {
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.ctx.csrfToken ? { 'X-CSRF-Token': this.ctx.csrfToken } : {}),
        ...(this.pat ? { 'PRIVATE-TOKEN': this.pat } : {}),
        ...(options.headers || {})
      };

      const res = await fetch(url, {
        ...options,
        headers,
        credentials: 'same-origin'
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data?.message) {
            msg = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
          } else if (data?.error) {
            msg = data.error;
          }
        } catch (_) {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }

      if (res.status === 204) return null;
      return res.json();
    }

    getMergeRequest() {
      return this.request(`/merge_requests/${this.ctx.mrIid}`);
    }

    getVersions() {
      return this.request(`/merge_requests/${this.ctx.mrIid}/versions`);
    }

    getVersionDetail(versionId) {
      return this.request(`/merge_requests/${this.ctx.mrIid}/versions/${versionId}`);
    }

    async getChanges() {
      // Prefer GitLab's modern /diffs endpoint (supports pagination); fall back to /changes for older servers
      try {
        const diffs = await this.request(`/merge_requests/${this.ctx.mrIid}/diffs?per_page=100`);
        if (Array.isArray(diffs)) {
          return { changes: diffs };
        }
      } catch (_) {}
      return this.request(`/merge_requests/${this.ctx.mrIid}/changes?access_raw_diffs=true`);
    }

    compareShas(fromSha, toSha) {
      return this.request(
        `/repository/compare?from=${encodeURIComponent(fromSha)}&to=${encodeURIComponent(toSha)}`
      );
    }

    getDiscussions() {
      return this.request(`/merge_requests/${this.ctx.mrIid}/discussions?per_page=100`);
    }

    getCommits() {
      return this.request(`/merge_requests/${this.ctx.mrIid}/commits?per_page=100`);
    }

    async getApprovals() {
      try {
        return await this.request(`/merge_requests/${this.ctx.mrIid}/approvals`);
      } catch (e) {
        // GitLab CE/Free or restricted permissions may return 404/403 on approvals
        return { approved_by: [], approvals_required: 0, approvals_left: 0, user_has_approved: false };
      }
    }

    async getCurrentUser() {
      try {
        return await this.request(`${this.ctx.origin}/api/v4/user`);
      } catch (_) {
        return null;
      }
    }

    postNote(body) {
      return this.request(`/merge_requests/${this.ctx.mrIid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body })
      });
    }

    async postInlineComment({ body, diffRefs, oldPath, newPath, oldLine, newLine }) {
      const position = {
        position_type: 'text',
        base_sha: diffRefs.base_sha,
        start_sha: diffRefs.start_sha,
        head_sha: diffRefs.head_sha,
        old_path: oldPath,
        new_path: newPath
      };
      if (newLine != null) position.new_line = newLine;
      if (oldLine != null) position.old_line = oldLine;

      try {
        return await this.request(`/merge_requests/${this.ctx.mrIid}/discussions`, {
          method: 'POST',
          body: JSON.stringify({ body, position })
        });
      } catch (e) {
        // Fallback if GitLab rejects position (e.g., outside diff context or outdated patchset)
        const lineRef = newLine != null ? `L${newLine}` : `old L${oldLine}`;
        return this.postNote(`**\`${newPath || oldPath}:${lineRef}\`**\n\n${body}`);
      }
    }

    replyToDiscussion(discussionId, body) {
      return this.request(`/merge_requests/${this.ctx.mrIid}/discussions/${discussionId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body })
      });
    }

    resolveDiscussion(discussionId, resolved) {
      return this.request(`/merge_requests/${this.ctx.mrIid}/discussions/${discussionId}`, {
        method: 'PUT',
        body: JSON.stringify({ resolved })
      });
    }

    approve() {
      return this.request(`/merge_requests/${this.ctx.mrIid}/approve`, {
        method: 'POST'
      });
    }

    unapprove() {
      return this.request(`/merge_requests/${this.ctx.mrIid}/unapprove`, {
        method: 'POST'
      });
    }

    merge(options = {}) {
      return this.request(`/merge_requests/${this.ctx.mrIid}/merge`, {
        method: 'PUT',
        body: JSON.stringify(options)
      });
    }

    updateMergeRequest(payload) {
      return this.request(`/merge_requests/${this.ctx.mrIid}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    }
  }

  return {
    detectMrContext,
    Client
  };
})();
