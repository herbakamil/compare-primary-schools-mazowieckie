// Methodology page: long bilingual prose. The text lives as two blocks in the
// HTML ([data-lang-block="pl"|"en"]); here we show the one for the current UI
// language and keep the nav/title labels translated (setLang → applyI18N).

(function () {
  function showLangContent() {
    for (const el of document.querySelectorAll('[data-lang-block]')) {
      el.hidden = el.getAttribute('data-lang-block') !== currentLang;
    }
  }
  setLang(resolvePref('lang', ['pl', 'en']));
  showLangContent();
  wireLangToggle(() => showLangContent());
}());
