// public/config.js
(function () {
  // Detect local dev
  const host = location.hostname;
  const isLocal =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host.endsWith('.local');

  // Merge with any existing config if needed (existing keys win)
  const prev = window.APP_CONFIG || {};

  window.APP_CONFIG = {
    ...prev,
    BRAND_NAME: 'Agentlyne',
    SUPPORT_EMAIL: 'info@chalfontwebs.com',
    // Same-origin in prod; localhost in dev
    API_BASE: isLocal ? 'http://127.0.0.1:5050' : '',
  };
})();
