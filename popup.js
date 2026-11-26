const autoEnableEl = document.getElementById('autoEnable');
const themeEl = document.getElementById('theme');
const patEl = document.getElementById('pat');
const statusEl = document.getElementById('status');

chrome.storage.sync.get({ autoEnable: true, theme: 'dark', pat: '' }, (items) => {
  autoEnableEl.checked = items.autoEnable;
  themeEl.value = items.theme;
  patEl.value = items.pat;
});

document.getElementById('saveBtn').addEventListener('click', () => {
  const settings = {
    autoEnable: autoEnableEl.checked,
    theme: themeEl.value,
    pat: patEl.value.trim()
  };
  chrome.storage.sync.set(settings, () => {
    statusEl.textContent = 'Settings saved!';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'RELOAD_GERRIT_SETTINGS' }).catch(() => {});
      }
    });
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
});

document.getElementById('toggleBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_GERRIT_VIEW' }).catch(() => {
        statusEl.textContent = 'Open a GitLab Merge Request page first.';
      });
    }
  });
});
