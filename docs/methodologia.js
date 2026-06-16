// Methodology page: static info, content to be filled in later. For now it
// only needs to resolve the UI language (URL > localStorage > default) and
// translate the static labels. The language toggle is wired by wireLangToggle
// (shared, in app.js) once present on the page.

(function () {
  setLang(resolvePref('lang', ['pl', 'en']));
  if (typeof wireLangToggle === 'function') {
    wireLangToggle(() => {
      writePref('lang', currentLang);
    });
  }
}());
