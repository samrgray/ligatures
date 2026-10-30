// Applies the saved appearance (Light or Dark) and font before the page paints, so they don't flash.
// “Auto” stores nothing and follows the system setting.
(function () {
  try {
    var t = localStorage.getItem('ligature-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    // The font you chose last time, until your account’s setting arrives.
    var f = localStorage.getItem('ligature-font');
    if (f && /^[A-Za-z ]+$/.test(f)) document.documentElement.style.setProperty('--font', "'" + f + "'");
  } catch (e) {
    /* storage blocked: follow the system */
  }
})();
