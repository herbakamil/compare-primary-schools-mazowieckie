# Plan widoczności i promocji

Dokument roboczy dla osoby pomagającej od strony marketingu / SEO. Checkboxy
odhaczamy w repo — ten plik jest źródłem prawdy o postępie. Stan opisany
poniżej: **25 listopada 2026**.

---

## 1. Czym jest projekt

**Mapa i ranking szkół podstawowych w województwie mazowieckim** na podstawie
wyników egzaminu ósmoklasisty (dane OKE Warszawa, lata 2021–2026, 1743 szkoły).

- Strona: https://herbakamil.github.io/compare-primary-schools-mazowieckie/
- Kod i dane: https://github.com/herbakamil/compare-primary-schools-mazowieckie

Stack: strona w pełni statyczna (HTML + vanilla JS + Leaflet), hostowana za
darmo na GitHub Pages, bez backendu. Dane odświeżane raz w roku (lipiec–sierpień,
po publikacji wyników przez OKE).

**Wyróżniki względem konkurencji** (uczciwie: to są wyróżniki dla wymagającego
odbiorcy, nie dla masowego):

- pełna jawność: surowe pliki OKE, przetworzone xlsx i JSON-y serwowane stronie
  są w publicznym repo; niezależny skrypt walidacyjny sprawdza eksport
  ~1,3 mln porównań;
- metryka wybrana testem stabilności (leave-one-out), a nie arbitralnie;
- komunikacja niepewności wbudowana w UI (zakresy pozycji, ostrzeżenia przy
  krótkiej historii, neutralne etykiety klas);
- zero cookies, zero reklam, zero bannera zgód.

## 2. Stan wyjściowy — twarde fakty

Zrobione:

- strona działa i jest kompletna funkcjonalnie (mapa, ranking, strona Pomocy
  dwujęzyczna PL/EN);
- jednorazowe posty: grupa rodziców (Google), LinkedIn, grupa FB porównywania
  szkół w Warszawie (sierpień 2026);
- klucz API do podkładu mapowego (CARTO) skonfigurowany.

Braki — i to one definiują ten plan:

- **Zero indeksacji w Google.** Zapytanie `site:herbakamil.github.io/...`
  zwracało 0 wyników (weryfikacja 10.09.2026). Google nigdy strony nie znalazł.
- **Treść niewidoczna dla robotów.** Mapa i ranking renderują się JavaScriptem
  z JSON-a: surowy HTML strony głównej to 6 KB bez ani jednej nazwy szkoły.
  Rodzic szukający „SP 114 Warszawa wyniki" nie ma czego znaleźć — tego ciągu
  nie ma w żadnym HTML-u.
- Brak: własnej domeny, tagów Open Graph (link na FB/LinkedIn renderuje się
  bez opisu i miniatury), `meta description`, `sitemap.xml`, `robots.txt`
  (na GitHub Pages w podkatalogu i tak niemożliwy — wymaga własnej domeny),
  Google Search Console, jakiejkolwiek analityki.
- Zero linków zewnętrznych prowadzących do strony (poza postami w zamkniętych
  grupach, których Google nie widzi).

Ograniczenia hostingu (niewiążące): limit 100 GB/mies. transferu ≈ 64 tys.
świeżych wizyt/mies. (1,58 MB gzip na pierwszą wizytę; powracający dostają
HTTP 304 i ~0 B, bo dane zmieniają się raz w roku).

## 3. Konkurencja (stan: listopad 2026)

| Serwis | Zakres | Uwagi |
|---|---|---|
| **szkolynamapie.pl** | obwody szkolne + wyniki E8, 21 największych miast, rankingi per województwo | **nowy, najbliższy zakresem**; pojawił się między wrześniem a listopadem 2026 |
| **waszaedukacja.pl** | ogólnopolski katalog ~43 tys. placówek, rankingi, progi, opinie | duży, zasiedziały |
| mapa.wyniki.edu.pl | mapa wyników egzaminów | |
| rankingedukacji.pl | rankingi szkół | |

Wniosek pozycjonerski: frazy ogólne („ranking szkół podstawowych warszawa")
są zajęte przez graczy z historią domeny. Realny teren to **długi ogon**:
zapytania o konkretne gminy i konkretne szkoły — patrz Faza 4.

## 4. Plan

### Faza 1 — domena (warunkuje prawie wszystko dalej)

Kandydaci (status DNS z 25.11.2026 — brak delegacji ≈ prawdopodobnie wolna;
**potwierdzić w wyszukiwarce rejestratora przed zakupem**):

- [ ] wybór nazwy. **Warunek twardy (decyzja właściciela): region musi być
      w nazwie** — serwis obejmuje tylko Mazowsze i nazwa bez regionu byłaby
      oszustwem; ewentualny ogólnopolski serwis za lata dostanie własną domenę,
      a ta będzie przekierowywać. Kandydaci (wolne wg DNS 25.11.2026;
      potwierdzić u rejestratora): **`szkolypodstawowemazowieckie.pl`**
      (faworyt dotychczasowej dyskusji — precyzyjna co do typu szkół
      i regionu, 30 znaków), `szkolymazowieckie.pl` (20),
      `szkolynamazowszu.pl` (19, najnaturalniejsza w mowie),
      `szkolymazowsza.pl` (17).
      Poza listą: rodzina „na mapie" — `szkolynamapie.pl` to od jesieni żywy
      konkurent, podobna nazwa wyglądałaby jak podszywanie się.
- [ ] rejestrator — kryteria wyboru: **cena odnowienia** (nie promocyjna
      pierwszoroczna), darmowe **przekierowanie e-mail** (kontakt@ → prywatna
      skrzynka), ewentualnie SMTP w pakiecie; bez hostingu (zbędny).
- [ ] rekordy DNS: 4×A (185.199.108–111.153) + 4×AAAA (2606:50c0:8000–8003::153)
      na apex, `www CNAME herbakamil.github.io.`; TTL 600–3600 na czas konfiguracji.
- [ ] plik `CNAME` w `docs/` (robi Claude po podaniu nazwy).
- [ ] GitHub → Settings → Pages → Custom domain → wpisać domenę → po wydaniu
      certyfikatu zaznaczyć **Enforce HTTPS** (do ~24 h).
- [ ] **dopisać nową domenę do klucza CARTO** (carto.com/basemaps/apikey) —
      inaczej kafelki mapy wrócą do znaku wodnego.
- [ ] test: stary adres github.io przekierowuje na nową domenę (robi się sam).

### Faza 2 — techniczne SEO (jeden pakiet zmian po domenie)

- [ ] tagi Open Graph (`og:title/description/image/url`) na 3 stronach +
      obrazek 1200×630 w repo — naprawia wygląd linka na FB/LinkedIn/WhatsApp;
      UWAGA: już opublikowane posty nie odświeżą karty (LinkedIn zamraża ją
      w chwili publikacji) — działa dla wszystkich przyszłych udostępnień.
- [ ] `meta description` per strona (to jest opis w wynikach Google).
- [ ] `rel=canonical` per strona.
- [ ] `robots.txt` (z własną domeną wreszcie w korzeniu, więc działający)
      + `sitemap.xml` z adresami bezwzględnymi.
- [ ] Google Search Console: property typu **Domain**, weryfikacja rekordem
      TXT w DNS; zgłosić sitemap; „Request indexing" dla 3 stron.
- [ ] pole About → Website w repo GitHub (dziś puste).

### Faza 3 — pomiar, e-mail, prywatność

- [ ] analityka bez cookies: **GoatCounter** (darmowy dla niekomercyjnych,
      bez bannera zgód) — da odsłony, źródła wejść, miasta, urządzenia.
      Świadomie nie GA4: wymaga zgód i karmi Google danymi odwiedzających.
- [ ] `kontakt@domena` → przekierowanie na prywatną skrzynkę (rejestrator
      albo Cloudflare Email Routing — oba darmowe); wysyłka „w drugą stronę"
      przez Gmail „Wyślij jako" + hasło aplikacji.
- [ ] krótka sekcja „Prywatność" na stronie Pomocy: zero cookies, co widzi
      statystyka, jakie zasoby ładują się z zewnątrz (kafelki mapy = CARTO
      widzi IP jak każdy serwer). To atut do powiedzenia wprost, nie obowiązek.

### Faza 4 — treść, którą Google ma co indeksować (największa dźwignia)

Dziś strona nie ma żadnej treści statycznej do dopasowania zapytań. Plan:

- [ ] **strony gminne** (~216 gmin z ≥3 szkołami; tytuł nazwą miejscowości,
      np. „Szkoły podstawowe Pruszków — wyniki egzaminu ósmoklasisty").
      Na stronie: średnia gminy na tle województwa (unikalna treść!), statyczna
      tabela szkół z wynikami, linki do mapy/rankingu przefiltrowanych
      (`?q=Pruszków` już działa), linki do sąsiednich gmin. Generowane
      z istniejącego JSON-a przy eksporcie.
- [ ] **strony per szkoła** (1743) — długi ogon „SP 114 Warszawa wyniki";
      prawie pusta konkurencja na te frazy. Druga iteracja, po gminnych
      (ta sama maszyneria szablonowa). Bonus: wizyta z Google na stronę
      szkoły to ~10 KB zamiast 1,58 MB.
- [ ] statyczny indeks wszystkich szkół (ścieżka odkrycia dla robota).
- [ ] znane ograniczenie: **Warszawa = 377 szkół (22%) bez dzielnicy** w danych
      OKE, więc frazy „szkoły podstawowe mokotów" poza zasięgiem; opcja:
      przypisanie dzielnic point-in-polygon z granic m.st. (mamy współrzędne
      szkół; granice dzielnic to otwarte dane).
- [ ] ryzyko do pilnowania: setki generowanych stron = wzorzec „doorway pages";
      obrona: każda strona niesie realne, unikalne dane (6 lat × 3 przedmioty
      × wynik/miejsce/percentyl), nie zajawkę.

### Faza 5 — dystrybucja

- [ ] **kalendarz jest strategią**: rekrutacja do klas I trwa ~luty–kwiecień;
      wtedy popyt jest pilny, dziś żaden. Strony i indeksacja muszą dojrzeć
      do ~stycznia, posty powtórzyć w sezonie.
- [ ] **linki zewnętrzne** — dla świeżej domeny ważą więcej niż całe on-page
      SEO razem wzięte. Pomysły do oceny: lokalne media (z wyraźnym linkiem
      do sekcji „Co nie jest celem" — ryzyko przeinaczenia w „ranking
      najlepszych"!), blogi rodzicielskie/edukacyjne, społeczności open data
      (jawny pipeline to dla nich treść sama w sobie), zestawienia narzędzi.
- [ ] powtórka w grupach rodzicielskich (dzielnicowe grupy „rekrutacja /
      przyszli pierwszoklasiści") — luty.
- [ ] rozważyć notkę prasową z gotowym akapitem metodycznym.

### Faza 6 — pętla zwrotna

- [ ] przegląd Search Console po 4–6 tygodniach od indeksacji (wyświetlenia,
      frazy) — wcześniej dane nic nie powiedzą; świeża domena bez linków
      nie pozycjonuje się w tydzień.
- [ ] decyzja o drugiej iteracji treści na podstawie fraz, które realnie
      przynoszą wyświetlenia.

## 5. Pytania do Ciebie (osoby od SEO/marketingu)

1. **Nazwa domeny** — region w nazwie to warunek nienegocjowalny (patrz
   Faza 1). Spór do rozstrzygnięcia w obrębie wariantów regionalnych:
   pełna precyzja typu szkół (`szkolypodstawowemazowieckie.pl`, 30 znaków)
   vs krótsze (`szkolymazowieckie.pl`, `szkolynamazowszu.pl`). Czy długość
   realnie boli pod SEO/brand, skoro nikt adresów nie wpisuje ręcznie?
2. **Gminy czy szkoły najpierw?** Nasz argument za gminami: 216 stron zamiast
   1743, bogatsza pojedyncza strona; za szkołami: niemal zerowa konkurencja
   w długim ogonie.
3. **Źródła linków** — konkretne tytuły/serwisy/ludzie, do których warto
   zapukać w naszym temacie?
4. Czy widzisz ryzyka (doorway, kanibalizacja fraz między gminą a szkołą),
   których nie uwzględniliśmy?
5. Czego brakuje w tym planie?
