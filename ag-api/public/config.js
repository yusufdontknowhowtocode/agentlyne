(function () {
  const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

  window.APP_CONFIG = {
    BRAND_NAME: 'Agentlyne',
    SUPPORT_EMAIL: 'info@chalfontwebs.com',
    // Same-origin API; no hard-coded domain needed
    API_BASE: isLocal ? 'http://127.0.0.1:5050' : '', // '' means same origin in production
  };
})();
