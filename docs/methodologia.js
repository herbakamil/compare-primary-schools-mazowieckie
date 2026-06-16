// Methodology page: static info, content to be filled in later. For now it
// only needs to resolve the UI language (URL > localStorage > default) and
// translate the static labels. The language toggle is wired by wireLangToggle
// (shared, in app.js) once present on the page.

(function () {
  setLang(resolvePref('lang', ['pl', 'en']));
  // Static page: setLang already re-translates the labels, so no extra
  // re-render is needed after a language switch.
  wireLangToggle();
}());
