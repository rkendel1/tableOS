// Applies the saved stack-ui theme before the app renders (same key and attribute as
// @stack-ui/core's theme.js: THEME_STORAGE_KEY "stack-ui.theme", data-stack-theme on <html>).
// A file, not an inline script, so it works under a CSP that allows only same-origin scripts.
try {
  var theme = localStorage.getItem("stack-ui.theme");
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-stack-theme", theme);
} catch (e) {}
