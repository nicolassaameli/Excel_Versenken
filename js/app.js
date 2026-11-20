// =====================================================================
//  Zellen versenken – Benutzeroberfläche
// =====================================================================
(function () {
  "use strict";
  const { SIZE, FLEET, FLEET_BY_ID, TOTAL_CELLS, shipCells, canPlace, shipAt,
    isCompleteFleet, normalizeState } = window.ZV;
  const { OnlineBackend, LocalBackend } = window.ZVBackends;
  const F = window.ZVFormula;
  const SCAN_MS = 2500; // so lange bleibt das Suchergebnis sichtbar

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function colName(i) {
    let s = "";
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  const ref = (r, c) => colName(c) + (r + 1);
  function parseRef(text) {
    const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,3})\s*$/.exec(text || "");
    if (!m) return null;
    let c = 0;
    for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { r: parseInt(m[2], 10) - 1, c: c - 1 };
  }

  // -------------------------------------------------------------------
  //  Zustand
  // -------------------------------------------------------------------
  const App = {
    online: null,
    backend: null,
    session: null,
    state: null,
    unsub: null,
    busy: false,
    refreshing: false,
    refreshPending: false,
    sheet: "gefecht",
    grid: null,
    sel: { r: 0, c: 1 },
    selEnd: null,        // zweite Ecke einer Bereichsauswahl
    zoom: 100,
    draft: { ships: [] },
    typed: null,         // Live-Vorschau der getippten Formel
    point: null,         // Zeigemodus: zuletzt per Klick eingefügter Bezug
    scan: null,          // aktuell sichtbares Suchergebnis
    fmt: {},             // Zellformatierung des Spielers: "r,c" -> Farbe
    fillColor: "#ffc000",
    fxCount: { ok: 0, bad: 0 },
    ribbonTab: "start",
    gameOverShown: false,
    ribbonSig: "",
  };

  // -------------------------------------------------------------------
  //  Tabellen-Engine (HTML-Tabelle mit Spaltenköpfen, Zeilennummern, Verbund)
  // -------------------------------------------------------------------
  class Grid {
    constructor(table, spec) {
      this.table = table;
      this.cols = spec.cols;
      this.rows = spec.rows;
      this.nR = this.rows.length;
      this.nC = this.cols.length;
      this.cover = [];
      this.span = {};
      for (let r = 0; r < this.nR; r++) {
        this.cover[r] = [];
        for (let c = 0; c < this.nC; c++) this.cover[r][c] = [r, c];
      }
      for (const [r, c, rs, cs] of spec.merges || []) {
        this.span[r + "," + c] = [rs, cs];
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) this.cover[r + i][c + j] = [r, c];
      }
      this.tds = {};
      this.model = {};
      this.cache = {};
      this.build();
    }
    build() {
      let html = '<colgroup><col style="width:44px">' + this.cols.map((w) => `<col style="width:${w}px">`).join("") + "</colgroup>";
      html += '<thead><tr><th class="corner"></th>' + this.cols.map((_, c) => `<th data-col="${c}">${colName(c)}</th>`).join("") + "</tr></thead><tbody>";
      for (let r = 0; r < this.nR; r++) {
        html += `<tr style="height:${this.rows[r]}px"><th data-row="${r}">${r + 1}</th>`;
        for (let c = 0; c < this.nC; c++) {
          const [ar, ac] = this.cover[r][c];
          if (ar !== r || ac !== c) continue;
          const sp = this.span[r + "," + c];
          html += `<td data-r="${r}" data-c="${c}"${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ""}></td>`;
        }
        html += "</tr>";
      }
      this.table.innerHTML = html + "</tbody>";
      this.table.style.width = 44 + this.cols.reduce((a, b) => a + b, 0) + "px";
      $$("td", this.table).forEach((td) => { this.tds[td.dataset.r + "," + td.dataset.c] = td; });
      this.colThs = $$("thead th[data-col]", this.table);
      this.rowThs = $$("tbody th", this.table);
    }
    // m = { v: Text, html: HTML, f: Formel, cls: Klassen }
    set(r, c, m) {
      const key = r + "," + c;
      const td = this.tds[key];
      if (!td) return;
      this.model[key] = m;
      const html = m.html != null ? m.html : esc(m.v);
      const sig = (m.cls || "") + "|" + (m.fill || "") + "|" + html;
      if (this.cache[key] === sig) return;
      this.cache[key] = sig;
      td.className = m.cls || "";
      td.style.backgroundColor = m.fill || "";
      td.innerHTML = html;
    }
    get(r, c) {
      const [ar, ac] = this.cover[r][c];
      return this.model[ar + "," + ac] || null;
    }
    td(r, c) {
      const [ar, ac] = this.cover[r][c];
      return this.tds[ar + "," + ac];
    }
    spanOf(r, c) {
      const [ar, ac] = this.cover[r][c];
      const sp = this.span[ar + "," + ac] || [1, 1];
      return { r: ar, c: ac, rs: sp[0], cs: sp[1] };
    }
  }

  // -------------------------------------------------------------------
  //  Phasen
  // -------------------------------------------------------------------
  function phase() {
    const s = App.state;
    if (!s) return "none";
    if (s.status === "finished") return "finished";
    if (s.status === "playing") return s.turn === s.seat ? "myturn" : "oppturn";
    if (!s.myReady) return "setup";
    return "readywait";
  }
  const shipName = (id) => (FLEET_BY_ID[id] ? FLEET_BY_ID[id].name : id);

  function stats() {
    const s = App.state;
    if (!s) return { myShots: 0, myHits: 0, oppShots: 0, oppHits: 0 };
    return {
      myShots: s.myShots.length,
      myHits: s.myShots.filter((x) => x.hit).length,
      oppShots: s.oppShots.length,
      oppHits: s.oppShots.filter((x) => x.hit).length,
    };
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + " %" : "0 %");

  // =====================================================================
  //  Blatt "Gefecht"
  // =====================================================================
  const BR0 = 5;     // erste Zeile der Spielfelder
  const ME_C0 = 2;   // Spalte C
  const OPP_C0 = 14; // Spalte O

  function battleSpec() {
    const cols = [24, 26];
    for (let i = 0; i < 10; i++) cols.push(30);
    cols.push(26, 26);
    for (let i = 0; i < 10; i++) cols.push(30);
    cols.push(24);
    for (let i = 0; i < 8; i++) cols.push(64);
    const rows = [];
    for (let r = 0; r < 42; r++) rows.push(20);
    rows[0] = 40; rows[1] = 22; rows[2] = 10; rows[3] = 26; rows[4] = 24;
    for (let r = BR0; r < BR0 + 10; r++) rows[r] = 30;
    rows[15] = 14; rows[16] = 22; rows[22] = 14; rows[23] = 22;
    const merges = [[0, 1, 1, 23], [1, 1, 1, 23], [3, 1, 1, 11], [3, 13, 1, 11], [23, 13, 6, 11]];
    for (let r = 16; r <= 21; r++) merges.push([r, 1, 1, 5], [r, 6, 1, 2], [r, 8, 1, 4], [r, 13, 1, 5], [r, 18, 1, 2], [r, 20, 1, 4]);
    for (let r = 23; r <= 26; r++) merges.push([r, 1, 1, 5], [r, 6, 1, 3], [r, 9, 1, 3]);
    merges.push([27, 1, 1, 11]);
    return { cols, rows, merges };
  }

  function boardAt(r, c) {
    if (App.sheet !== "gefecht" || r < BR0 || r >= BR0 + SIZE) return null;
    if (c >= ME_C0 && c < ME_C0 + SIZE) return { who: "me", r: r - BR0, c: c - ME_C0 };
    if (c >= OPP_C0 && c < OPP_C0 + SIZE) return { who: "opp", r: r - BR0, c: c - OPP_C0 };
    return null;
  }

  // Spielfeldkoordinaten (0–9) -> echte Zellbezüge im Blatt
  const myRef = (r, c) => ref(BR0 + r, ME_C0 + c);
  const oppRef = (r, c) => ref(BR0 + r, OPP_C0 + c);
  const ME_AREA = `${myRef(0, 0)}:${myRef(SIZE - 1, SIZE - 1)}`;
  const OPP_AREA = `${oppRef(0, 0)}:${oppRef(SIZE - 1, SIZE - 1)}`;
  function shipRange(ship) {
    const cells = shipCells(ship);
    const a = cells[0], b = cells[cells.length - 1];
    return myRef(a.r, a.c) + ":" + myRef(b.r, b.c);
  }
  const shipFormula = (ship) => `=${F.SHIP_FUNC[ship.id].name}(${shipRange(ship)})`;
  const fmtKey = (r, c) => r + "," + c;

  function edgeCls(r, c) {
    let e = "";
    if (r === 0) e += " edge-t";
    if (r === SIZE - 1) e += " edge-b";
    if (c === 0) e += " edge-l";
    if (c === SIZE - 1) e += " edge-r";
    return e;
  }

  function hintText() {
    const s = App.state;
    const ph = phase();
    if (ph === "none") return "Willkommen! Öffne «Datei» → «Neu», um ein Spiel zu starten, oder tritt mit einem Code einem Spiel bei.";
    const opp = s.oppName || "Dein Gegner";
    switch (ph) {
      case "setup":
        return (s.status === "waiting" ? `Warte auf einen Gegner – teile den Code ${s.code} (Start → Einladen). Du kannst die Flotte schon platzieren. ` : "")
          + `Platziere deine Schiffe mit Formeln in deinem Feld ${ME_AREA}, z. B. =FLUGZEUGTRÄGER(C6:G6) oder =KREUZER(E8:E10). `
          + "Tipp: Während du tippst, kannst du den Bereich auch mit der Maus aufziehen. Wenn alle fünf liegen: =BEREIT()";
      case "readywait":
        return s.status === "waiting"
          ? `Deine Flotte ist bereit. Warte, bis jemand mit dem Code ${s.code} beitritt …`
          : `Deine Flotte ist bereit. Warte, bis ${opp} die Schiffe platziert hat …`;
      case "myturn":
        return `Du bist am Zug! Schiesse mit =FEUER(Q8) auf eine Zelle im gegnerischen Feld ${OPP_AREA} – ein Treffer gibt einen weiteren Schuss. `
          + "Oder suche mit =SUCHEN(Q8:R9) 2×2 Zellen ab: Das Ergebnis erscheint nur kurz, markiere es mit einer Füllfarbe (Start → Füllfarbe).";
      case "oppturn":
        return `${opp} ist am Zug und zielt auf deine Flotte …`;
      case "finished":
        if (s.winner === s.seat) return s.resigned ? `${opp} hat aufgegeben. Du gewinnst!` : "Gewonnen! Alle gegnerischen Schiffe liegen auf dem Meeresgrund. Neues Spiel über Datei → Neu.";
        return s.resigned ? "Du hast aufgegeben. Neues Spiel über Datei → Neu." : `Verloren – ${opp} hat deine Flotte versenkt. Neues Spiel über Datei → Neu.`;
    }
    return "";
  }

  function updateBattle(g) {
    const s = App.state;
    const ph = phase();
    const st = stats();

    // Titel
    g.set(0, 1, { v: "Zellen versenken", cls: "title", f: "Zellen versenken" });
    const phaseLabel = { none: "kein Spiel geöffnet", setup: "Schiffe platzieren", readywait: "warte auf Gegner",
      myturn: "du bist am Zug", oppturn: "Gegner ist am Zug", finished: "Spiel beendet" }[ph];
    const sub = s
      ? `Spiel-Code: ${s.code}   ·   ${s.myName} vs. ${s.oppName || "—"}   ·   Status: ${phaseLabel}`
      : "Schiffe versenken in Zellen. Datei → Neu startet ein Spiel.";
    g.set(1, 1, { v: sub, cls: "subtitle", f: sub });

    // Überschriften der Felder
    const meTitle = "Meine Flotte" + (s ? " – " + s.myName : "");
    const oppTitle = "Gegner" + (s && s.oppName ? " – " + s.oppName : s ? " – wartet …" : "");
    g.set(3, 1, { v: meTitle, cls: "h1" + (ph === "oppturn" ? " wait" : "") , f: meTitle });
    g.set(3, 13, { v: oppTitle + (ph === "myturn" ? "   ◄ DU BIST DRAN" : ""), cls: "h1" + (ph === "myturn" ? " turn" : ph === "oppturn" ? "" : " wait"), f: oppTitle });

    // Beschriftungen
    for (const c0 of [ME_C0, OPP_C0]) {
      g.set(4, c0 - 1, { v: "", cls: "lbl" });
      for (let c = 0; c < SIZE; c++) g.set(4, c0 + c, { v: colName(c0 + c), cls: "lbl", f: colName(c0 + c) });
      for (let r = 0; r < SIZE; r++) g.set(BR0 + r, c0 - 1, { v: String(BR0 + r + 1), cls: "lbl", f: String(BR0 + r + 1) });
    }

    // ---------- eigenes Feld ----------
    const myShips = s && s.myReady ? s.myShips : App.draft.ships;
    const oppHit = new Map();
    if (s) s.oppShots.forEach((x) => oppHit.set(x.r * SIZE + x.c, x));
    const lastOpp = s && s.oppShots.length ? s.oppShots[s.oppShots.length - 1] : null;
    const oppSunkIds = new Set(s ? s.oppShots.filter((x) => x.sunk).map((x) => x.sunk) : []);

    const preview = App.typed;
    const pvCls = (sr, sc) => (preview && preview.set.has(fmtKey(sr, sc)) ? (preview.ok ? " pv-ok" : " pv-bad") : "");
    const fill = (sr, sc) => App.fmt[fmtKey(sr, sc)] || "";

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const ship = shipAt(myShips, r, c);
        const shot = oppHit.get(r * SIZE + c);
        let cls = "bd" + edgeCls(r, c);
        let v = "";
        let f = "";
        if (ship) { cls += " ship"; f = shipFormula(ship); }
        if (shot) {
          if (shot.hit) {
            const sunk = ship && oppSunkIds.has(ship.id);
            cls += sunk ? " sunk" : " hit"; v = "X";
            f = sunk ? `=VERSENKT("${shipName(ship.id)}")` : `=TREFFER("${ship ? shipName(ship.id) : ""}")`;
          } else { cls += " miss"; v = "•"; f = "=WASSER()"; }
        }
        cls += pvCls(BR0 + r, ME_C0 + c);
        if (lastOpp && lastOpp.r === r && lastOpp.c === c && ph !== "finished") cls += " last";
        g.set(BR0 + r, ME_C0 + c, { v, cls, f, fill: shot || ship ? "" : fill(BR0 + r, ME_C0 + c), board: { who: "me", r, c } });
      }
    }

    // ---------- gegnerisches Feld ----------
    const myShot = new Map();
    if (s) s.myShots.forEach((x) => myShot.set(x.r * SIZE + x.c, x));
    const lastMine = s && s.myShots.length ? s.myShots[s.myShots.length - 1] : null;
    const mySunkIds = new Set(s ? s.myShots.filter((x) => x.sunk).map((x) => x.sunk) : []);
    const oppShips = s ? s.oppShips : [];
    const oppActive = ph === "myturn";
    g.table.classList.toggle("board-opp-active", oppActive);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const shot = myShot.get(r * SIZE + c);
        const ship = shipAt(oppShips, r, c);
        let cls = "bd" + edgeCls(r, c);
        let v = "";
        let f = "";
        if (shot) {
          if (shot.hit) {
            if (ship && mySunkIds.has(ship.id)) { cls += " sunk"; f = `=VERSENKT("${shipName(ship.id)}")`; }
            else { cls += " hit"; f = "=TREFFER()"; }
            v = "X";
          } else { cls += " miss"; v = "•"; f = "=WASSER()"; }
        } else if (ship && ph === "finished") {
          cls += " reveal"; f = `=VERSTECKT("${shipName(ship.id)}")`;
        } else {
          cls += " opp-free";
        }
        const sc = App.scan ? App.scan.cells.get(r * SIZE + c) : undefined;
        if (sc !== undefined && !shot) { cls += sc ? " scan-yes" : " scan-no"; v = sc ? "?" : "~"; }
        cls += pvCls(BR0 + r, OPP_C0 + c);
        if (lastMine && lastMine.r === r && lastMine.c === c && ph !== "finished") cls += " last";
        const userFill = shot || sc !== undefined ? "" : fill(BR0 + r, OPP_C0 + c);
        if (ph !== "myturn" && ph !== "finished" && !shot && sc === undefined && !userFill) cls += " dim";
        g.set(BR0 + r, OPP_C0 + c, { v, cls, f, fill: userFill, board: { who: "opp", r, c } });
      }
    }

    // ---------- Flottentabellen ----------
    g.set(16, 1, { v: "Meine Schiffe", cls: "th-blue" });
    g.set(16, 6, { v: "Länge", cls: "th-blue ctr" });
    g.set(16, 8, { v: "Status", cls: "th-blue ctr" });
    g.set(16, 13, { v: "Gegnerische Schiffe", cls: "th-blue" });
    g.set(16, 18, { v: "Länge", cls: "th-blue ctr" });
    g.set(16, 20, { v: "Status", cls: "th-blue ctr" });

    FLEET.forEach((def, i) => {
      const row = 17 + i;
      const band = i % 2 === 0 ? " band" : "";
      const bar = `<span class="databar" style="width:calc(${(def.len / 5) * 100}% - 4px)"></span><span class="cell-txt">${def.len}</span>`;
      const typing = ph === "setup" && App.typed && App.typed.ship === def.id;

      // eigene
      let status, scls;
      if (!s || !s.myReady) {
        const placed = App.draft.ships.find((x) => x.id === def.id);
        status = placed ? shipRange(placed) : typing ? "wird platziert" : "offen";
        scls = placed ? "good" : typing ? "neutral" : "muted";
      } else {
        const ship = s.myShips.find((x) => x.id === def.id);
        const hits = ship ? shipCells(ship).filter((p) => (oppHit.get(p.r * SIZE + p.c) || {}).hit).length : 0;
        if (hits >= def.len) { status = "versenkt"; scls = "badc"; }
        else if (hits > 0) { status = `getroffen ${hits}/${def.len}`; scls = "neutral"; }
        else { status = "intakt"; scls = "good"; }
      }
      const placedShip = App.draft.ships.find((x) => x.id === def.id);
      const fxText = placedShip ? shipFormula(placedShip) : F.SHIP_FUNC[def.id].name + "(Bereich)";
      g.set(row, 1, { v: (typing ? "▶ " : "") + def.name, cls: band + (typing ? " b" : ""), f: fxText, shipRow: def.id });
      g.set(row, 6, { html: bar, cls: "ctr" + band, f: String(def.len) });
      g.set(row, 8, { v: status, cls: "ctr " + scls + (placedShip && !(s && s.myReady) ? " mono" : ""), f: fxText, shipRow: def.id });

      // gegnerische
      const sunk = mySunkIds.has(def.id);
      let ostatus = sunk ? "versenkt" : "unbekannt";
      let ocls = sunk ? "badc" : "muted";
      if (!sunk && ph === "finished") { ostatus = "überlebt"; ocls = "neutral"; }
      g.set(row, 13, { v: def.name, cls: band });
      g.set(row, 18, { html: bar, cls: "ctr" + band, f: String(def.len) });
      g.set(row, 20, { v: ostatus, cls: "ctr " + ocls, f: ostatus });
    });

    // ---------- Statistik ----------
    g.set(23, 1, { v: "Kennzahl", cls: "th-green" });
    g.set(23, 6, { v: "Ich", cls: "th-green ctr" });
    g.set(23, 9, { v: "Gegner", cls: "th-green ctr" });
    g.set(24, 1, { v: "Schüsse", cls: "band-g" });
    g.set(24, 6, { v: String(st.myShots), cls: "rt band-g", f: "=ANZAHL2(O6:X15)" });
    g.set(24, 9, { v: String(st.oppShots), cls: "rt band-g", f: '=ZÄHLENWENN(C6:L15;"•")+ZÄHLENWENN(C6:L15;"X")' });
    g.set(25, 1, { v: "Treffer", cls: "" });
    g.set(25, 6, { v: String(st.myHits), cls: "rt", f: '=ZÄHLENWENN(O6:X15;"X")' });
    g.set(25, 9, { v: String(st.oppHits), cls: "rt", f: '=ZÄHLENWENN(C6:L15;"X")' });
    g.set(26, 1, { v: "Trefferquote", cls: "band-g" });
    g.set(26, 6, { v: pct(st.myHits, st.myShots), cls: "rt band-g", f: "=WENNFEHLER(G26/G25;0)" });
    g.set(26, 9, { v: pct(st.oppHits, st.oppShots), cls: "rt band-g", f: "=WENNFEHLER(J26/J25;0)" });
    g.set(27, 1, { v: `Verbleibend beim Gegner: ${TOTAL_CELLS - st.myHits} Zellen`, cls: "i muted",
      f: `=${TOTAL_CELLS}-G26` });

    // ---------- Hinweis ----------
    const hint = hintText();
    g.set(23, 13, { html: `<b>💡 Hinweis</b><br>${esc(hint)}`, cls: "wrap note", f: hint });
  }

  // =====================================================================
  //  Blatt "Protokoll"
  // =====================================================================
  function protocolShots() {
    const s = App.state;
    if (!s) return [];
    const all = s.myShots.map((x) => ({ ...x, who: s.myName, mine: true }))
      .concat(s.oppShots.map((x) => ({ ...x, who: s.oppName, mine: false })));
    all.sort((a, b) => a.id - b.id);
    return all;
  }
  function protocolSpec() {
    const n = protocolShots().length;
    const rows = [];
    for (let r = 0; r < Math.max(40, n + 8); r++) rows.push(20);
    rows[0] = 40;
    return { cols: [50, 150, 120, 110, 150, 90, 24, 64, 64, 64, 64, 64, 64], rows, merges: [[0, 0, 1, 6]] };
  }
  function updateProtocol(g) {
    const shots = protocolShots();
    if (g.nR < shots.length + 8) { renderSheet(true); return; }
    g.set(0, 0, { v: "Gefechtsprotokoll", cls: "title" });
    ["Nr.", "Spieler", "Formel", "Ergebnis", "Schiff", "Zeit"].forEach((h, c) => g.set(2, c, { v: h, cls: "th-blue" + (c === 0 || c === 2 ? " ctr" : "") }));
    for (let i = 0; i < g.nR - 3; i++) {
      const r = 3 + i;
      const x = shots[i];
      const band = i % 2 === 0 ? " band" : "";
      if (!x) { for (let c = 0; c < 6; c++) g.set(r, c, { v: "", cls: "" }); continue; }
      const res = x.sunk ? "versenkt" : x.hit ? "Treffer" : "Wasser";
      const t = x.t ? new Date(x.t).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
      g.set(r, 0, { v: String(i + 1), cls: "ctr" + band });
      g.set(r, 1, { v: x.who + (x.mine ? " (ich)" : ""), cls: band + (x.mine ? " b" : "") });
      const fx = `=FEUER(${x.mine ? oppRef(x.r, x.c) : myRef(x.r, x.c)})`;
      g.set(r, 2, { v: fx, cls: "mono" + band, f: fx });
      g.set(r, 3, { v: res, cls: x.sunk ? "badc" : x.hit ? "neutral" : band });
      g.set(r, 4, { v: x.sunk ? shipName(x.sunk) : "", cls: band });
      g.set(r, 5, { v: t, cls: "rt" + band });
    }
    if (!shots.length) g.set(3, 1, { v: "Noch keine Schüsse.", cls: "i muted" });
  }

  // =====================================================================
  //  Blatt "Hilfe"
  // =====================================================================
  const HELP = [
    ["title", "Hilfe – Zellen versenken"],
    [],
    ["h1", "Ziel"],
    ["", "Versenke alle fünf Schiffe deines Gegners, bevor er deine versenkt."],
    [],
    ["h1", "So geht's – alles läuft über Formeln"],
    ["", "1.  Datei → Neu → «Neues Online-Spiel». Teile den Code oder Link über Start → Einladen."],
    ["", "2.  Dein Gegner öffnet den Link oder gibt den Code unter Datei → Öffnen ein."],
    ["", "3.  Platziere jedes Schiff mit seiner Funktion in deinem Feld C6:L15, z. B. =FLUGZEUGTRÄGER(C6:G6)."],
    ["", "     Der Bereich muss genau so lang sein wie das Schiff und in einer Zeile oder Spalte liegen."],
    ["", "4.  Sobald alle fünf Schiffe liegen: =BEREIT(). Wer beginnt, entscheidet der Zufall."],
    ["", "5.  Am Zug: =FEUER(Q8) schiesst auf eine Zelle im gegnerischen Feld O6:X15. Treffer = nochmals schiessen."],
    ["", "6.  Oder =SUCHEN(Q8:R9): zeigt kurz, wo in diesen 2×2 Zellen Schiffe liegen. Kostet den Zug."],
    ["", "     Merke dir das Ergebnis mit Start → Füllfarbe oder Zellenformatvorlagen (Gut / Schlecht / Neutral)."],
    [],
    ["h1", "Formeln (in die Bearbeitungsleiste tippen)"],
    ...F.FUNCS.map((f) => ["fx", f.example, f.desc]),
    [],
    ["h1", "Formel-Regeln"],
    ["", "•  Jede Formel beginnt mit «=». Danach folgt der Funktionsname und eine Klammer – auch wenn sie leer bleibt: =BEREIT()"],
    ["", "•  Ein Zellbezug ist Spaltenbuchstabe + Zeilennummer: Q8 (nicht 8Q, nicht \"Q8\")."],
    ["", "•  Ein Bereich ist erste Zelle, Doppelpunkt, letzte Zelle: C6:G6 (nicht C6-G6, nicht C6;G6)."],
    ["", "•  Während du tippst, fügt ein Klick in eine Zelle ihren Bezug ein. Mit gedrückter Maustaste ziehst du einen Bereich auf."],
    ["", "•  Tab übernimmt einen Vorschlag der Autovervollständigung."],
    [],
    ["h1", "Flotte"],
    ...FLEET.map((f) => ["ship", f.name, f.len]),
    [],
    ["h1", "Legende"],
    ["leg", "ship", "", "Eigenes Schiff"],
    ["leg", "hit", "X", "Treffer"],
    ["leg", "sunk", "X", "Versenkt"],
    ["leg", "miss", "•", "Wasser"],
    ["leg", "scan-yes", "?", "SUCHEN: hier liegt ein Schiff (nur kurz sichtbar)"],
    ["leg", "scan-no", "~", "SUCHEN: hier ist Wasser (nur kurz sichtbar)"],
    ["leg", "reveal", "", "Nach Spielende aufgedecktes gegnerisches Schiff"],
    [],
    ["muted", "Tastatur: Pfeiltasten bewegen die Auswahl · Shift+Pfeil erweitert sie · = oder ein Buchstabe startet eine Formel"],
  ];
  function helpSpec() {
    const rows = HELP.map((h) => (h[0] === "title" ? 40 : h[0] === "h1" ? 26 : 22));
    while (rows.length < 40) rows.push(20);
    const merges = [];
    HELP.forEach((h, r) => { if (h[0] !== "fx" && h[0] !== "leg" && h[0] !== "ship") merges.push([r, 1, 1, 3]); });
    return { cols: [24, 30, 250, 760, 64, 64, 64, 64, 64, 64], rows, merges };
  }
  function updateHelp(g) {
    HELP.forEach((h, r) => {
      const [kind, a, b, c] = h;
      if (!kind && !a) return;
      if (kind === "ship") {
        g.set(r, 1, { html: '<span class="cell-txt">' + "■".repeat(b) + "</span>", cls: "muted", f: String(b) });
        g.set(r, 2, { v: a, cls: "" });
        g.set(r, 3, { v: `Länge ${b}`, cls: "muted" });
      } else if (kind === "fx") {
        g.set(r, 1, { v: "", cls: "" });
        g.set(r, 2, { v: a, cls: "mono b", f: a });
        g.set(r, 3, { v: b, cls: "", f: b });
      } else if (kind === "leg") {
        g.set(r, 1, { v: b, cls: "bd " + a });
        g.set(r, 2, { v: c, cls: "" });
      } else {
        g.set(r, 1, { v: a, cls: kind === "muted" ? "i muted" : kind, f: a });
      }
    });
  }

  const SHEETS = {
    gefecht: { name: "Gefecht", spec: battleSpec, update: updateBattle },
    protokoll: { name: "Protokoll", spec: protocolSpec, update: updateProtocol },
    hilfe: { name: "Hilfe", spec: helpSpec, update: updateHelp },
  };

  function renderSheet(rebuild) {
    const def = SHEETS[App.sheet];
    if (rebuild || !App.grid || App.grid.sheet !== App.sheet) {
      App.grid = new Grid($("#grid"), def.spec());
      App.grid.sheet = App.sheet;
      if (App.sel.r >= App.grid.nR || App.sel.c >= App.grid.nC) App.sel = { r: 0, c: 0 };
    }
    def.update(App.grid);
    updateSelection();
  }

  function switchSheet(key) {
    if (App.sheet === key) return;
    App.sheet = key;
    App.selEnd = null;
    App.sel = key === "gefecht" ? (App.lastBattleSel || { r: BR0, c: OPP_C0 }) : { r: key === "protokoll" ? 2 : 0, c: key === "protokoll" ? 0 : 1 };
    renderSheet(true);
    renderSheetTabs();
    $("#sheetScroll").scrollTo(0, 0);
  }

  // -------------------------------------------------------------------
  //  Auswahl, Namenfeld, Bearbeitungsleiste
  // -------------------------------------------------------------------
  function select(r, c, opts = {}) {
    const g = App.grid;
    r = Math.max(0, Math.min(g.nR - 1, r));
    c = Math.max(0, Math.min(g.nC - 1, c));
    const sp = g.spanOf(r, c);
    if (opts.extend) {
      App.selEnd = { r: sp.r, c: sp.c };
    } else {
      App.sel = { r: sp.r, c: sp.c };
      App.selEnd = null;
    }
    if (App.sheet === "gefecht") App.lastBattleSel = App.sel;
    updateSelection();
    if (opts.scroll) {
      const t = opts.extend ? App.selEnd : App.sel;
      const td = g.td(t.r, t.c);
      if (td) td.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    renderRibbonIfChanged();
  }

  // Ausgewählter Bereich als Rechteck (mit verbundenen Zellen)
  function selRect() {
    const g = App.grid;
    const a = g.spanOf(App.sel.r, App.sel.c);
    const b = App.selEnd ? g.spanOf(App.selEnd.r, App.selEnd.c) : a;
    return {
      r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c),
      r1: Math.max(a.r + a.rs, b.r + b.rs) - 1, c1: Math.max(a.c + a.cs, b.c + b.cs) - 1,
    };
  }

  function updateSelection() {
    const g = App.grid;
    if (!g) return;
    const rc = selRect();
    const tdA = g.td(rc.r0, rc.c0);
    const tdB = g.td(rc.r1, rc.c1);
    const box = $("#selBox");
    if (tdA && tdB) {
      box.style.display = "block";
      box.style.left = tdA.offsetLeft - 1 + "px";
      box.style.top = tdA.offsetTop - 1 + "px";
      box.style.width = tdB.offsetLeft + tdB.offsetWidth - tdA.offsetLeft + 1 + "px";
      box.style.height = tdB.offsetTop + tdB.offsetHeight - tdA.offsetTop + 1 + "px";
      box.classList.toggle("multi", !!App.selEnd);
    }
    g.colThs.forEach((th, i) => th.classList.toggle("hl", i >= rc.c0 && i <= rc.c1));
    g.rowThs.forEach((th, i) => th.classList.toggle("hl", i >= rc.r0 && i <= rc.r1));
    const multi = rc.r0 !== rc.r1 || rc.c0 !== rc.c1;
    const name = App.selEnd && multi ? ref(rc.r0, rc.c0) + ":" + ref(rc.r1, rc.c1) : ref(App.sel.r, App.sel.c);
    if (document.activeElement !== $("#nameBox")) $("#nameBox").value = name;
    if (document.activeElement !== $("#formulaInput")) {
      const m = g.get(App.sel.r, App.sel.c);
      $("#formulaInput").value = m ? (m.f != null ? m.f : m.v != null ? m.v : "") : "";
    }
    updateStatusbar();
  }

  // -------------------------------------------------------------------
  //  Spielaktionen
  // -------------------------------------------------------------------
  // =FLUGZEUGTRÄGER(C6:G6) usw. – liefert eine Fehlermeldung oder null
  function placeShip(f, a) {
    const ph = phase();
    if (ph === "none") return { state: "Starte zuerst ein Spiel (Datei → Neu)." };
    if (ph !== "setup") return { state: "Die Flotte ist schon abgegeben – Schiffe lassen sich nicht mehr verschieben." };
    const def = FLEET_BY_ID[f.ship];
    const inMe = (r, c) => r >= BR0 && r < BR0 + SIZE && c >= ME_C0 && c < ME_C0 + SIZE;
    const inOpp = (r, c) => r >= BR0 && r < BR0 + SIZE && c >= OPP_C0 && c < OPP_C0 + SIZE;
    if (!inMe(a.r0, a.c0) || !inMe(a.r1, a.c1)) {
      const where = inOpp(a.r0, a.c0) && inOpp(a.r1, a.c1) ? " – das ist das gegnerische Feld" : "";
      return { code: "#BEZUG!", msg: `Der Bereich ${a.text} liegt nicht in deinem Feld ${ME_AREA}${where}.`, fix: f.example };
    }
    const h = a.r1 - a.r0 + 1, w = a.c1 - a.c0 + 1;
    if (h > 1 && w > 1) {
      return { code: "#WERT!", msg: `Ein Schiff liegt in einer einzigen Zeile oder Spalte. ${a.text} ist ${h} Zeilen hoch und ${w} Spalten breit.`, fix: f.example };
    }
    const n = Math.max(h, w);
    if (n !== def.len) {
      const art = def.id === "uboot" ? "Das" : "Der";
      return { code: "#WERT!", msg: `${art} ${def.name} ist ${def.len} Zellen lang, ${a.text} umfasst aber ${n === 1 ? "nur eine Zelle" : n + " Zellen"}.`, fix: f.example };
    }
    const ship = { id: def.id, len: def.len, dir: w > 1 ? "h" : "v", r: a.r0 - BR0, c: a.c0 - ME_C0 };
    const others = App.draft.ships.filter((x) => x.id !== def.id);
    if (!canPlace(ship, others)) {
      const hit = shipCells(ship).map((p) => shipAt(others, p.r, p.c)).find(Boolean);
      return { code: "#WERT!", msg: `${a.text} überschneidet sich mit ${shipName(hit.id)} (${shipRange(hit)}). Schiffe dürfen sich berühren, aber nicht überlappen.` };
    }
    const moved = App.draft.ships.some((x) => x.id === def.id);
    App.draft.ships = others.concat([ship]);
    const next = FLEET.find((x) => !App.draft.ships.some((y) => y.id === x.id));
    setMsg(`${def.name} ${moved ? "verschoben nach" : "platziert auf"} ${a.text}.` + (next ? ` Noch offen: ${next.name} (${next.len}).` : " Alle Schiffe liegen – jetzt =BEREIT()"), "good");
    renderAll();
    return null;
  }

  function clearFleet() {
    if (phase() !== "setup") return { state: "Die Flotte kann jetzt nicht mehr geändert werden." };
    App.draft.ships = [];
    setMsg("Flotte geleert.");
    renderAll();
    return null;
  }

  async function submitReady() {
    if (phase() !== "setup") return;
    if (!isCompleteFleet(App.draft.ships)) {
      const open = FLEET.filter((x) => !App.draft.ships.some((y) => y.id === x.id)).map((x) => x.name);
      setMsg(`Es fehlen noch: ${open.join(", ")}.`, "bad");
      return;
    }
    if (App.busy) return;
    App.busy = true;
    try {
      await App.backend.submitShips(App.session, App.draft.ships.map(({ id, len, r, c, dir }) => ({ id, len, r, c, dir })));
      setMsg("Flotte abgegeben.", "good");
      await refresh();
    } catch (e) {
      errorBox(e);
    } finally {
      App.busy = false;
      renderAll();
    }
  }

  async function fireAt(r, c) {
    const s = App.state;
    if (!s) return;
    const ph = phase();
    if (ph === "setup" || ph === "readywait") { setMsg("Das Gefecht hat noch nicht begonnen.", "bad"); return; }
    if (ph === "finished") { setMsg("Das Spiel ist vorbei.", "bad"); return; }
    if (ph === "oppturn") { setMsg(`${s.oppName} ist am Zug.`, "bad"); return; }
    if (s.myShots.some((x) => x.r === r && x.c === c)) { setMsg(`Auf ${oppRef(r, c)} hast du schon geschossen.`, "bad"); return; }
    if (App.busy) return;
    App.busy = true;
    try {
      const res = await App.backend.fire(App.session, r, c);
      const cc = oppRef(r, c);
      if (res.win) setMsg(`${cc}: Treffer – versenkt! Alle Schiffe zerstört!`, "good");
      else if (res.sunk) setMsg(`${cc}: Treffer – ${shipName(res.sunk)} versenkt! Du darfst nochmals.`, "good");
      else if (res.hit) setMsg(`${cc}: Treffer! Du darfst nochmals schiessen.`, "good");
      else setMsg(`${cc}: Wasser. ${s.oppName} ist dran.`);
      App.flash = { r: BR0 + r, c: OPP_C0 + c };
      await refresh();
    } catch (e) {
      errorBox(e);
    } finally {
      App.busy = false;
      renderAll();
    }
  }

  // =SUCHEN(Q8:R9): Ergebnis nur kurz einblenden
  async function scanAt(r, c) {
    const s = App.state;
    const ph = phase();
    if (ph === "setup" || ph === "readywait") { setMsg("Das Gefecht hat noch nicht begonnen.", "bad"); return; }
    if (ph === "finished") { setMsg("Das Spiel ist vorbei.", "bad"); return; }
    if (ph === "oppturn") { setMsg(`${s.oppName} ist am Zug.`, "bad"); return; }
    if (App.busy) return;
    App.busy = true;
    try {
      const res = await App.backend.scan(App.session, r, c);
      const cells = new Map(res.cells.map((x) => [x.r * SIZE + x.c, !!x.ship]));
      const n = res.cells.filter((x) => x.ship).length;
      clearTimeout(App.scanTimer);
      App.scan = { cells };
      App.scanTimer = setTimeout(() => { App.scan = null; renderAll(); }, SCAN_MS);
      const area = `${oppRef(r, c)}:${oppRef(r + 1, c + 1)}`;
      setMsg(`Suche ${area}: ${n === 0 ? "nur Wasser" : n === 1 ? "1 Zelle mit Schiff" : n + " Zellen mit Schiff"}. Schnell markieren – das Ergebnis verschwindet gleich!`, n ? "good" : "");
      await refresh();
    } catch (e) {
      errorBox(e);
    } finally {
      App.busy = false;
      renderAll();
    }
  }

  async function resignGame() {
    const ph = phase();
    if (ph === "none" || ph === "finished") return;
    const ok = await dialog({
      icon: "⚠️", html: "<div class='big'>Wirklich aufgeben?</div>Dein Gegner gewinnt damit das Spiel.",
      buttons: [{ label: "Aufgeben", value: true, primary: true }, { label: "Abbrechen", value: false }],
    });
    if (!ok) return;
    try { await App.backend.resign(App.session); await refresh(); } catch (e) { errorBox(e); }
  }

  // -------------------------------------------------------------------
  //  Sitzungen
  // -------------------------------------------------------------------
  const store = {
    get name() { return localStorage.getItem("zv.name") || ""; },
    set name(v) { localStorage.setItem("zv.name", v); },
    sessions() { try { return JSON.parse(localStorage.getItem("zv.sessions") || "[]"); } catch { return []; } },
    save(list) { localStorage.setItem("zv.sessions", JSON.stringify(list.slice(0, 12))); },
    upsert(entry) {
      const list = this.sessions().filter((x) => x.code !== entry.code);
      list.unshift(entry);
      this.save(list);
    },
    find(code) { return this.sessions().find((x) => x.code === (code || "").toUpperCase()); },
    remove(code) { this.save(this.sessions().filter((x) => x.code !== code)); localStorage.removeItem("zv.fmt." + code); },
    // Zellformatierung pro Spiel (nur im eigenen Browser)
    fmt(code) { try { return JSON.parse(localStorage.getItem("zv.fmt." + code) || "{}"); } catch { return {}; } },
    saveFmt(code, fmt) { localStorage.setItem("zv.fmt." + code, JSON.stringify(fmt)); },
  };

  async function startSession(backend, session) {
    if (App.unsub) App.unsub();
    App.backend = backend;
    App.session = session;
    App.state = null;
    App.draft = { ships: [] };
    App.typed = null;
    App.scan = null;
    App.selEnd = null;
    App.fxCount = { ok: 0, bad: 0 };
    App.fmt = session.mode === "online" ? store.fmt(session.code) : {};
    App.gameOverShown = false;
    App.sheet = "gefecht";
    App.sel = { r: BR0, c: ME_C0 };
    App.lastBattleSel = null;
    App.unsub = backend.subscribe(session, () => refresh());
    if (session.mode === "online") {
      history.replaceState(null, "", location.pathname + "?spiel=" + session.code);
    } else {
      history.replaceState(null, "", location.pathname);
    }
    closeBackstage();
    renderSheet(true);
    renderSheetTabs();
    await refresh();
  }

  async function refresh() {
    if (!App.session) return;
    if (App.refreshing) { App.refreshPending = true; return; }
    App.refreshing = true;
    try {
      const raw = await App.backend.getState(App.session);
      const st = normalizeState(raw);
      const prev = App.state;
      App.state = st;
      if (st.myReady && (!prev || !prev.myReady)) App.draft.ships = clone(st.myShips);
      detectEvents(prev, st);
      if (App.session.mode === "online") {
        store.upsert({ code: st.code, token: App.session.token, seat: st.seat, name: st.myName, opp: st.oppName || "", status: st.status, at: Date.now() });
      }
      renderAll();
    } catch (e) {
      if (/Ungültige Sitzung/.test(e.message)) {
        store.remove(App.session.code);
        closeSession();
        errorBox(new Error("Diese Spielsitzung ist nicht mehr gültig."));
      } else {
        setMsg("Verbindungsproblem: " + e.message, "bad");
      }
    } finally {
      App.refreshing = false;
      if (App.refreshPending) { App.refreshPending = false; refresh(); }
    }
  }

  function closeSession() {
    if (App.unsub) App.unsub();
    App.unsub = null;
    App.session = null;
    App.state = null;
    history.replaceState(null, "", location.pathname);
    renderAll();
  }

  function detectEvents(prev, st) {
    const opp = st.oppName || "Gegner";
    if (prev) {
      if (!prev.oppName && st.oppName) toast(`${st.oppName} ist dem Spiel beigetreten.`);
      if (!prev.oppReady && st.oppReady && st.status !== "playing") toast(`${opp} hat die Flotte platziert.`);
      if (prev.status !== "playing" && st.status === "playing") {
        setMsg(st.turn === st.seat ? "Das Gefecht beginnt – du hast den ersten Schuss!" : `Das Gefecht beginnt – ${opp} schiesst zuerst.`, "good");
        if (App.sheet === "gefecht") select(BR0, OPP_C0);
      }
      if (st.oppShots.length > prev.oppShots.length) {
        const x = st.oppShots[st.oppShots.length - 1];
        const cc = myRef(x.r, x.c);
        if (x.sunk) setMsg(`${opp} schiesst auf ${cc}: Dein ${shipName(x.sunk)} wurde versenkt!`, "bad");
        else if (x.hit) setMsg(`${opp} schiesst auf ${cc}: Treffer!`, "bad");
        else setMsg(`${opp} schiesst auf ${cc}: Wasser.` + (st.turn === st.seat ? " Du bist dran!" : ""));
        App.flash = { r: BR0 + x.r, c: ME_C0 + x.c };
      }
      const ls = st.lastScan;
      if (st.scansCount > prev.scansCount && ls && ls.seat !== st.seat) {
        setMsg(`${opp} hat mit SUCHEN deine Zellen ${myRef(ls.r, ls.c)}:${myRef(ls.r + 1, ls.c + 1)} abgesucht. Du bist dran!`, "bad");
        App.flash = { r: BR0 + ls.r, c: ME_C0 + ls.c };
      }
    }
    if (st.status === "finished" && !App.gameOverShown) {
      App.gameOverShown = true;
      setTimeout(showGameOver, prev ? 500 : 50);
    }
  }

  async function showGameOver() {
    const s = App.state;
    if (!s) return;
    const st = stats();
    const won = s.winner === s.seat;
    const html = won
      ? `<div class="big">Gratulation, du hast gewonnen!</div>` + (s.resigned ? `${esc(s.oppName)} hat aufgegeben.` : `Alle Schiffe versenkt mit ${st.myShots} Schüssen (Trefferquote ${pct(st.myHits, st.myShots)}).`)
      : `<div class="big">Leider verloren.</div>` + (s.resigned ? "Du hast aufgegeben." : `${esc(s.oppName)} hat deine Flotte versenkt. Du hast ${st.myHits} von ${TOTAL_CELLS} Zellen getroffen.`);
    const v = await dialog({ icon: won ? "🏆" : "🌊", html, buttons: [{ label: "Neues Spiel", value: "new", primary: true }, { label: "Schliessen", value: null }] });
    if (v === "new") openBackstage("neu");
  }

  async function newOnline() {
    if (!App.online) { errorBox(new Error("Online-Modus nicht konfiguriert (js/config.js).")); return; }
    const name = requireName();
    if (!name) return;
    try {
      const session = await App.online.create(name);
      await startSession(App.online, session);
      showInvite();
    } catch (e) { errorBox(e); }
  }

  async function newLocal() {
    const name = requireName() || "Spieler";
    const local = new LocalBackend();
    const session = await local.create(name);
    await startSession(local, session);
    setMsg("Spiel gegen den Computer gestartet. Platziere deine Flotte!", "good");
  }

  async function joinGame(code) {
    code = (code || "").trim().toUpperCase();
    if (!code) { errorBox(new Error("Bitte einen Spiel-Code eingeben.")); return; }
    if (!App.online) { errorBox(new Error("Online-Modus nicht konfiguriert (js/config.js).")); return; }
    const known = store.find(code);
    if (known) { resume(known); return; }
    const name = requireName();
    if (!name) return;
    try {
      const session = await App.online.join(code, name);
      await startSession(App.online, session);
      toast(`Du bist dem Spiel ${code} beigetreten.`);
    } catch (e) { errorBox(e); }
  }

  async function resume(entry) {
    if (!App.online) return;
    await startSession(App.online, { code: entry.code, token: entry.token, seat: entry.seat, mode: "online" });
  }

  function requireName() {
    const input = $("#playerName");
    const name = (input.value || "").trim();
    if (!name) {
      openBackstage("start");
      input.focus();
      setTimeout(() => input.focus(), 50);
      toast("Bitte zuerst deinen Namen eingeben.");
      return null;
    }
    store.name = name;
    return name;
  }

  function inviteLink() {
    return location.origin + location.pathname + "?spiel=" + (App.state ? App.state.code : App.session.code);
  }

  async function showInvite() {
    if (!App.session || App.session.mode !== "online") { toast("Einladungen gibt es nur bei Online-Spielen."); return; }
    const code = App.session.code;
    const link = inviteLink();
    const v = await dialog({
      icon: "🔗",
      html: `<div class="big">Gegner einladen</div>Teile diesen Code oder Link mit deinem Gegner:<br>
             <span class="dlg-code">${esc(code)}</span><input class="dlg-link" readonly value="${esc(link)}">`,
      buttons: [{ label: "Link kopieren", value: "copy", primary: true }, { label: "Schliessen", value: null }],
      onOpen: (el) => { const i = $(".dlg-link", el); i.addEventListener("focus", () => i.select()); },
    });
    if (v === "copy") copyText(link);
  }

  function copyText(text) {
    const done = () => toast("Link in die Zwischenablage kopiert.");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { toast(text); }
      ta.remove();
    }
  }

  // -------------------------------------------------------------------
  //  Formeln
  // -------------------------------------------------------------------
  function runFormula(text) {
    const t = (text || "").trim();
    if (!t) return;
    // Spass muss sein
    if (/^=\s*SUMME\s*\(/i.test(t)) { toast("Summe der versenkten Hoffnungen: unbezahlbar."); return; }
    const p = F.parse(t);
    if (!p.ok) { formulaError(p, t); return; }
    const { f, arg } = p;
    let res = null;
    switch (f.kind) {
      case "ship":
        if (App.sheet !== "gefecht") switchSheet("gefecht");
        res = placeShip(f, arg);
        break;
      case "fire": res = fireFormula(f, arg); break;
      case "scan": res = scanFormula(f, arg); break;
      case "ready":
        if (phase() !== "setup") res = { state: "=BEREIT() geht nur, solange du deine Flotte platzierst." };
        else submitReady();
        break;
      case "clear": res = clearFleet(); break;
      case "help": switchSheet("hilfe"); break;
    }
    if (res && res.code) { formulaError(res, t); return; }
    if (res && res.state) setMsg(res.state, "bad");
    App.fxCount.ok++;
    updateStatusbar();
  }

  function inOppBoard(a) {
    const inOpp = (r, c) => r >= BR0 && r < BR0 + SIZE && c >= OPP_C0 && c < OPP_C0 + SIZE;
    return inOpp(a.r0, a.c0) && inOpp(a.r1, a.c1);
  }
  function inMyBoard(a) {
    const inMe = (r, c) => r >= BR0 && r < BR0 + SIZE && c >= ME_C0 && c < ME_C0 + SIZE;
    return inMe(a.r0, a.c0) && inMe(a.r1, a.c1);
  }

  function fireFormula(f, a) {
    if (!inOppBoard(a)) {
      const own = inMyBoard(a) ? " – das ist dein eigenes Feld! Auf die eigene Flotte schiesst man nicht" : "";
      return { code: "#BEZUG!", msg: `${a.text} liegt nicht im gegnerischen Feld ${OPP_AREA}${own}.`, fix: f.example };
    }
    if (App.sheet !== "gefecht") switchSheet("gefecht");
    select(a.r0, a.c0);
    fireAt(a.r0 - BR0, a.c0 - OPP_C0);
    return null;
  }

  function scanFormula(f, a) {
    if (!inOppBoard(a)) {
      const own = inMyBoard(a) ? " – das ist dein eigenes Feld" : "";
      return { code: "#BEZUG!", msg: `${a.text} liegt nicht im gegnerischen Feld ${OPP_AREA}${own}.`, fix: f.example };
    }
    const h = a.r1 - a.r0 + 1, w = a.c1 - a.c0 + 1;
    if (h !== 2 || w !== 2) {
      const ex = `${ref(a.r0, a.c0)}:${ref(Math.min(a.r0 + 1, BR0 + SIZE - 1), Math.min(a.c0 + 1, OPP_C0 + SIZE - 1))}`;
      return { code: "#WERT!", msg: `SUCHEN braucht genau 2×2 Zellen. ${a.text} ist ${h} ${h === 1 ? "Zeile" : "Zeilen"} hoch und ${w} ${w === 1 ? "Spalte" : "Spalten"} breit.`, fix: `=SUCHEN(${ex})` };
    }
    if (App.sheet !== "gefecht") switchSheet("gefecht");
    scanAt(a.r0 - BR0, a.c0 - OPP_C0);
    return null;
  }

  // Fehlermeldung wie in der Tabellenkalkulation – danach geht's zurück in die Formel
  async function formulaError(e, text) {
    App.fxCount.bad++;
    updateStatusbar();
    const fix = e.fix ? `<div class="fx-fix">Richtig wäre zum Beispiel: <code>${esc(e.fix)}</code></div>` : "";
    const head = e.code ? `<span class="fx-code">${esc(e.code)}</span> ` : "";
    const v = await dialog({
      icon: "❌",
      html: `<div class="big">${head}Bei dieser Formel liegt ein Problem vor.</div>`
        + `<div class="fx-wrong">Deine Formel: <code>${esc(text)}</code></div>${esc(e.msg)}${fix}`,
      buttons: [{ label: "Formel korrigieren", value: "edit", primary: true }, { label: "Abbrechen", value: null }],
    });
    if (v === "edit") editFormula(text);
  }

  function editFormula(text, caretBack = 0) {
    const fi = $("#formulaInput");
    fi.focus();
    fi.value = text;
    const pos = text.length - caretBack;
    fi.setSelectionRange(pos, pos);
    App.point = null;
    onFormulaInput();
  }

  // Vorlage aus Menüband / fx-Dialog in die Bearbeitungsleiste schreiben
  function insertFunction(f) {
    if (!f.arg) editFormula(`=${f.name}()`);
    else editFormula(`=${f.name}()`, 1);
  }

  // ---------- Autovervollständigung & Argument-Tipp ----------
  const fxPop = { items: [], active: 0 };

  function onFormulaInput() {
    const fi = $("#formulaInput");
    const before = fi.value.slice(0, fi.selectionStart);
    const pop = $("#fxPopup");
    let html = "";
    fxPop.items = [];
    const mName = /^=\s*([A-Za-zÄÖÜäöüß_.]*)$/.exec(before);
    const mArg = /^=\s*([A-Za-zÄÖÜäöüß_.]+)\s*\(([^)]*)$/.exec(before);
    if (mName && mName[1]) {
      fxPop.items = F.complete(mName[1]);
      fxPop.active = Math.min(fxPop.active, Math.max(0, fxPop.items.length - 1));
      html = fxPop.items.map((f, i) => `<div class="fx-item${i === fxPop.active ? " active" : ""}" data-fx="${i}">
          <span class="fx-ico">𝑓x</span><b>${esc(f.name)}</b><span class="fx-d">${esc(f.desc)}</span></div>`).join("");
      if (html) html += '<div class="fx-foot">Tab übernimmt den Vorschlag</div>';
    } else if (mArg) {
      const f = F.lookup(mArg[1]);
      if (f) {
        html = `<div class="fx-tip"><b>${esc(f.name)}</b>(${f.arg ? `<i>${esc(f.arg)}</i>` : ""})</div>`
          + `<div class="fx-tipd">${esc(f.arg ? f.argHint : f.desc)}</div>`;
      }
    }
    pop.innerHTML = html;
    pop.hidden = !html;
    if (html) pop.style.left = fi.offsetLeft + "px";
    updateTypedPreview();
  }

  function hidePopup() { $("#fxPopup").hidden = true; fxPop.items = []; }

  function acceptCompletion(i) {
    const f = fxPop.items[i];
    if (!f) return false;
    const fi = $("#formulaInput");
    const rest = fi.value.slice(fi.selectionStart);
    const head = `=${f.name}(`;
    fi.value = head + (f.arg ? "" : ")") + rest.replace(/^[A-Za-zÄÖÜäöüß_.]*/, "");
    const pos = f.arg ? head.length : head.length + 1;
    fi.setSelectionRange(pos, pos);
    fxPop.active = 0;
    onFormulaInput();
    return true;
  }

  // Getippte Formel live im Spielfeld anzeigen
  function updateTypedPreview() {
    const fi = $("#formulaInput");
    let typed = null;
    if (document.activeElement === fi && App.sheet === "gefecht") {
      const p = F.parse(fi.value.trim().endsWith(")") ? fi.value : fi.value + ")");
      if (p.ok && p.arg) {
        const a = p.arg;
        const set = new Set();
        for (let r = a.r0; r <= a.r1 && r - a.r0 < 12; r++) for (let c = a.c0; c <= a.c1 && c - a.c0 < 24; c++) set.add(fmtKey(r, c));
        let ok = false;
        if (p.f.kind === "ship") {
          const def = FLEET_BY_ID[p.f.ship];
          const h = a.r1 - a.r0 + 1, w = a.c1 - a.c0 + 1;
          const ship = { id: def.id, len: def.len, dir: w > 1 ? "h" : "v", r: a.r0 - BR0, c: a.c0 - ME_C0 };
          ok = inMyBoard(a) && Math.min(h, w) === 1 && Math.max(h, w) === def.len
            && canPlace(ship, App.draft.ships.filter((x) => x.id !== def.id));
          typed = { set, ok, ship: def.id };
        } else if (p.f.kind === "fire") {
          typed = { set, ok: inOppBoard(a) };
        } else if (p.f.kind === "scan") {
          typed = { set, ok: inOppBoard(a) && a.r1 - a.r0 === 1 && a.c1 - a.c0 === 1 };
        }
      }
    }
    if (JSON.stringify(typed && [...typed.set, typed.ok]) !== JSON.stringify(App.typed && [...App.typed.set, App.typed.ok])) {
      App.typed = typed;
      renderSheet();
    } else App.typed = typed;
  }

  // ---------- Zeigemodus: Klick in eine Zelle fügt den Bezug ein ----------
  function pointInsertAllowed(fi) {
    if (!fi.value.startsWith("=")) return false;
    if (App.point && App.point.end === fi.selectionStart && App.point.value === fi.value) return true;
    const before = fi.value.slice(0, fi.selectionStart).trimEnd();
    return /[=(;:,+\-*/&]$/.test(before);
  }
  function pointRef(r0, c0, r1, c1) {
    const fi = $("#formulaInput");
    const a = ref(Math.min(r0, r1), Math.min(c0, c1));
    const b = ref(Math.max(r0, r1), Math.max(c0, c1));
    const txt = a === b ? a : a + ":" + b;
    let start, end;
    if (App.point && App.point.value === fi.value) { start = App.point.start; end = App.point.end; }
    else { start = fi.selectionStart; end = fi.selectionEnd; }
    fi.value = fi.value.slice(0, start) + txt + fi.value.slice(end);
    const pos = start + txt.length;
    fi.setSelectionRange(pos, pos);
    App.point = { start, end: pos, value: fi.value, anchor: App.point && App.point.dragging ? App.point.anchor : { r: r0, c: c0 }, dragging: App.point && App.point.dragging };
    onFormulaInput();
  }

  // ---------- Zellformatierung ----------
  const FILLS = [
    ["#ffc000", "Orange"], ["#ffff00", "Gelb"], ["#92d050", "Hellgrün"], ["#00b0f0", "Hellblau"],
    ["#ff0000", "Rot"], ["#7030a0", "Lila"], ["#a6a6a6", "Grau"], ["#000000", "Schwarz"],
  ];
  const STYLES = [
    ["#c6efce", "Gut"], ["#ffc7ce", "Schlecht"], ["#ffeb9c", "Neutral"], ["#ddebf7", "Notiz"],
  ];

  function applyFill(color) {
    if (App.sheet !== "gefecht" || !App.session) { toast("Formatieren kannst du im Blatt «Gefecht» während eines Spiels."); return; }
    const rc = selRect();
    let n = 0;
    for (let r = rc.r0; r <= rc.r1; r++) {
      for (let c = rc.c0; c <= rc.c1; c++) {
        if (!boardAt(r, c)) continue;
        if (color) App.fmt[fmtKey(r, c)] = color; else delete App.fmt[fmtKey(r, c)];
        n++;
      }
    }
    if (!n) { toast("Füllfarben wirken nur in den beiden Spielfeldern."); return; }
    if (color) App.fillColor = color;
    if (App.session.mode === "online") store.saveFmt(App.session.code, App.fmt);
    App.ribbonSig = "";
    renderAll();
  }

  function showFormatMenu(anchor, kind) {
    closeMenus();
    const list = kind === "styles" ? STYLES : FILLS;
    const m = document.createElement("div");
    m.className = "fmt-menu" + (kind === "styles" ? " styles" : "");
    m.innerHTML = (kind === "styles"
      ? '<div class="fm-h">Gut, Schlecht und Neutral</div><div class="fm-styles">'
        + list.map(([c, n]) => `<button data-fill="${c}" style="background:${c}">${n}</button>`).join("") + "</div>"
      : '<div class="fm-h">Designfarben</div><div class="fm-sw">'
        + list.map(([c, n]) => `<button data-fill="${c}" title="${n}" style="background:${c}"></button>`).join("") + "</div>")
      + '<button class="fm-none" data-fill="">Keine Füllung</button>';
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = r.left + "px";
    m.style.top = r.bottom + 2 + "px";
    m.addEventListener("mousedown", (e) => e.preventDefault());
    m.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fill]");
      if (b) { closeMenus(); applyFill(b.dataset.fill); }
    });
    setTimeout(() => document.addEventListener("mousedown", closeMenusOutside), 0);
  }
  function closeMenusOutside(e) { if (!e.target.closest(".fmt-menu")) closeMenus(); }
  function closeMenus() {
    $$(".fmt-menu").forEach((x) => x.remove());
    document.removeEventListener("mousedown", closeMenusOutside);
  }

  // -------------------------------------------------------------------
  //  Menüband
  // -------------------------------------------------------------------
  const svg = (p, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
  const I = {
    paste: svg('<rect x="5" y="4" width="14" height="17" rx="1.5" fill="#f4e3b5" stroke="#8a6d1c"/><rect x="8.5" y="2.5" width="7" height="3.5" rx="1" fill="#fff" stroke="#555"/><rect x="10" y="10" width="11" height="12" fill="#fff" stroke="#555"/>'),
    cut: svg('<circle cx="6" cy="18" r="2.5"/><circle cx="14" cy="18" r="2.5"/><path d="M7.5 16L16 4M12.5 16L4 4"/>'),
    copy: svg('<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V4a1 1 0 00-1-1H5a1 1 0 00-1 1v12a1 1 0 001 1h3"/>'),
    brush: svg('<path d="M4 4h12v5H4z" fill="#ffd966"/><path d="M10 9v4M10 13l-1.5 7h3z"/>'),
    ship: svg('<path d="M3 15h18l-3 5H6z" fill="#7f9cc0" stroke="#2f4f75"/><path d="M8 15V9h7v6M11 9V5h2v4" stroke="#2f4f75"/><path d="M2 21c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1" stroke="#4a90d9"/>'),
    rotate: svg('<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>', 'style="color:#217346"'),
    dice: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="16" cy="16" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="16" r="1.2" fill="currentColor"/>'),
    eraser: svg('<path d="M15 4l5 5-9 9H6l-3-3z" fill="#f4b6c2" stroke="#a33"/><path d="M9 10l5 5M11 18h9"/>'),
    check: svg('<circle cx="12" cy="12" r="9" fill="#e2f3e8" stroke="#217346"/><path d="M7.5 12.5l3 3 6-7" stroke="#217346" stroke-width="2"/>'),
    newdoc: svg('<path d="M6 2.5h8l4 4V21.5H6z" fill="#fff"/><path d="M14 2.5v4h4"/><path d="M12 11v7M8.5 14.5h7" stroke="#217346" stroke-width="2"/>'),
    flag: svg('<path d="M5 21V3"/><path d="M5 4h12l-2.5 4L17 12H5" fill="#fff" stroke="#555"/>'),
    refresh: svg('<path d="M20 12a8 8 0 01-14.3 4.9M4 12A8 8 0 0118.3 7.1"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/>', 'style="color:#217346"'),
    table: svg('<rect x="3" y="4" width="18" height="16" rx="1" fill="#fff"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/><path d="M3 4h18v5H3z" fill="#4472c4" stroke="#4472c4"/>'),
    pivot: svg('<rect x="3" y="3" width="18" height="18" rx="1" fill="#fff"/><path d="M3 8h18M8 3v18"/><path d="M12 13h5v5" stroke="#217346"/>'),
    image: svg('<rect x="3" y="5" width="18" height="14" rx="1.5" fill="#fff"/><circle cx="8.5" cy="10" r="1.8" fill="#ffd966"/><path d="M3 17l5-5 4 4 3-3 6 6" stroke="#217346"/>'),
    shapes: svg('<circle cx="8" cy="9" r="5" fill="#cfe2f3"/><rect x="11" y="11" width="10" height="10" fill="#fce4d6"/>'),
    chart: svg('<path d="M4 20V10h4v10M10 20V5h4v15M16 20v-7h4v7" fill="#9dc3e6" stroke="#2f5597"/><path d="M2 20h20"/>'),
    pie: svg('<path d="M12 3a9 9 0 109 9h-9z" fill="#9dc3e6" stroke="#2f5597"/><path d="M14 2a8 8 0 018 8h-8z" fill="#f4b183" stroke="#c55a11"/>'),
    fx: '<svg viewBox="0 0 24 24"><text x="3" y="18" font-family="Times New Roman" font-style="italic" font-size="17" fill="#333">fx</text></svg>',
    sum: '<svg viewBox="0 0 24 24"><text x="5" y="19" font-family="Segoe UI" font-size="19" fill="#333">Σ</text></svg>',
    grid: svg('<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke-dasharray="2 2"/>'),
    zoom: svg('<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6"/>'),
    zoomIn: svg('<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6M10 7v6"/>'),
    zoomOut: svg('<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6"/>'),
    help: svg('<circle cx="12" cy="12" r="9" fill="#e7f0fb" stroke="#2f5597"/><path d="M9.5 9.5a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01" stroke="#2f5597" stroke-width="2"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01" stroke-width="2"/>'),
    comment: svg('<path d="M4 4h16v12H10l-5 4v-4H4z" fill="#fff4ce" stroke="#b58b00"/>'),
    lock: svg('<rect x="5" y="10" width="14" height="11" rx="1.5" fill="#fff4ce"/><path d="M8 10V7a4 4 0 018 0v3"/>'),
    spell: svg('<path d="M3 14l3-9 3 9M4 11h4M12 5h3a2 2 0 010 4h-3zM12 9h3.5a2.25 2.25 0 010 4.5H12z"/><path d="M13 19l2 2 5-5" stroke="#217346"/>'),
    palette: svg('<path d="M12 3a9 9 0 100 18c1.5 0 1.5-2 .5-3s0-3 2-3h2.5A4 4 0 0021 11c0-4.5-4-8-9-8z" fill="#fff"/><circle cx="7.5" cy="11" r="1.5" fill="#c00000"/><circle cx="10" cy="7" r="1.5" fill="#ffc000"/><circle cx="15" cy="7.5" r="1.5" fill="#70ad47"/>'),
    margins: svg('<rect x="4" y="3" width="16" height="18" fill="#fff"/><rect x="7" y="6" width="10" height="12" stroke-dasharray="2 2"/>'),
    orient: svg('<rect x="3" y="7" width="13" height="10" fill="#fff"/><rect x="11" y="3" width="10" height="13" fill="#fff"/>'),
    sortAZ: svg('<path d="M6 4v16M3 17l3 3 3-3"/><text x="11" y="10" font-size="8" fill="currentColor" stroke="none">A</text><text x="11" y="20" font-size="8" fill="currentColor" stroke="none">Z</text>'),
    filter: svg('<path d="M3 4h18l-7 8v7l-4 2v-9z" fill="#fff"/>'),
    freeze: svg('<rect x="3" y="3" width="18" height="18" fill="#fff"/><path d="M3 8h18M8 3v18" stroke="#217346" stroke-width="2"/>'),
    share: svg('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M18 8v6M15 11h6" stroke="#217346" stroke-width="2"/>'),
    alignL: svg('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    alignC: svg('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    alignR: svg('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    alignT: svg('<path d="M4 4h16M12 8v12M8 12l4-4 4 4"/>'),
    alignM: svg('<path d="M4 12h16M12 3v6M12 15v6"/>'),
    alignB: svg('<path d="M4 20h16M12 4v12M8 12l4 4 4-4"/>'),
    wrap: svg('<path d="M4 6h16M4 12h13a3 3 0 010 6h-4M15 16l-2 2 2 2M4 18h6"/>'),
    merge: svg('<rect x="3" y="6" width="18" height="12"/><path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2"/>'),
    border: svg('<rect x="4" y="4" width="16" height="16" stroke-dasharray="2 2"/><path d="M4 20h16" stroke-width="2.5"/>'),
    fill: svg('<path d="M5 12l7-7 7 7-7 7z" fill="#fff"/><path d="M3 21h18" stroke="#ffff00" stroke-width="3"/>'),
    fontcolor: '<svg viewBox="0 0 24 24"><text x="6" y="16" font-family="Segoe UI" font-size="14" font-weight="600" fill="#333">A</text><rect x="4" y="18" width="16" height="3" fill="#c00000"/></svg>',
    cond: svg('<rect x="3" y="3" width="18" height="18" fill="#fff"/><path d="M3 9h18M3 15h18M9 3v18"/><rect x="9" y="9" width="12" height="6" fill="#ffc7ce" stroke="none"/><rect x="9" y="15" width="12" height="6" fill="#c6efce" stroke="none"/>'),
    styles: svg('<rect x="3" y="4" width="8" height="7" fill="#c6efce" stroke="#006100"/><rect x="13" y="4" width="8" height="7" fill="#ffc7ce" stroke="#9c0006"/><rect x="3" y="13" width="8" height="7" fill="#ffeb9c" stroke="#9c5700"/><rect x="13" y="13" width="8" height="7" fill="#fff"/>'),
  };

  const dis = (b) => (b ? " disabled" : "");
  const big = (cmd, icon, label, o = {}) =>
    `<button class="rb big ${o.cls || ""}" data-cmd="${cmd}" data-label="${esc(label)}" title="${esc(o.title || label)}"${dis(o.disabled)}>${I[icon] || ""}<span>${label}</span></button>`;
  const small = (cmd, icon, label, o = {}) =>
    `<button class="rb small ${o.cls || ""}" data-cmd="${cmd}" data-label="${esc(label)}" title="${esc(o.title || label)}"${dis(o.disabled)}>${I[icon] || ""}<span>${label}</span></button>`;
  const ib = (cmd, inner, title, o = {}) =>
    `<button class="rb icon ${o.cls || ""}" data-cmd="${cmd}" data-label="${esc(title)}" title="${esc(title)}"${dis(o.disabled)}>${I[inner] || inner}</button>`;
  const grp = (label, body) => `<div class="rg"><div class="rg-body">${body}</div><div class="rg-label">${label}</div></div>`;
  const col = (...x) => `<div class="rcol">${x.join("")}</div>`;
  const row = (...x) => `<div class="rrow">${x.join("")}</div>`;
  const sel = (text, w) => `<span class="rsel" style="width:${w}px" data-cmd="deco" data-label="${esc(text)}">${text}</span>`;
  const chk = (cmd, label, on) => `<label class="rcheck"><input type="checkbox" data-cmd="${cmd}"${on ? " checked" : ""}> ${label}</label>`;
  const gly = (t, style) => `<b style="font-family:Georgia,serif;font-size:14px;width:16px;display:inline-block;text-align:center;${style || ""}">${t}</b>`;

  const RIBBON_TABS = [
    ["datei", "Datei"], ["start", "Start"], ["einfuegen", "Einfügen"], ["layout", "Seitenlayout"], ["formeln", "Formeln"],
    ["daten", "Daten"], ["pruefen", "Überprüfen"], ["ansicht", "Ansicht"], ["hilfe", "Hilfe"],
  ];

  function ribbonHtml() {
    const ph = phase();
    const setup = ph === "setup";
    const online = App.session && App.session.mode === "online";

    switch (App.ribbonTab) {
      case "start": {
        const ships = FLEET.map((f) => {
          const placed = (App.state && App.state.myReady ? App.state.myShips : App.draft.ships).find((x) => x.id === f.id);
          const fn = F.SHIP_FUNC[f.id].name;
          return `<button class="rb shipbtn${placed ? " placed" : ""}" data-cmd="ship" data-ship="${f.id}"${dis(!setup)} title="Fügt =${fn}( in die Bearbeitungsleiste ein (Länge ${f.len})">
            <span class="sb-name">${f.name}</span><span class="sb-boxes">${"<i></i>".repeat(f.len)}</span>
            <span class="sb-state">${placed ? "✓ " + shipRange(placed) : "=" + fn + "()"}</span></button>`;
        }).join("");
        const swatch = `<span class="fill-split"><button class="rb icon" data-cmd="fill" title="Füllfarbe auf die Auswahl anwenden" data-label="Füllfarbe">${svg('<path d="M5 12l7-7 7 7-7 7z" fill="#fff"/>')}<i class="fill-bar" style="background:${App.fillColor}"></i></button><button class="rb icon caret" data-cmd="fillmenu" title="Füllfarbe wählen" data-label="Füllfarbe">⌄</button></span>`;
        return grp("Zwischenablage", big("deco", "paste", "Einfügen") + col(small("deco", "cut", "Ausschneiden"), small("invite", "copy", "Kopieren", { title: "Einladungslink kopieren" }), small("deco", "brush", "Format übertragen")))
          + grp("Schriftart", col(row(sel("Calibri", 110), sel("11", 42)), row(ib("deco", gly("F"), "Fett"), ib("deco", gly("K", "font-style:italic;font-weight:400"), "Kursiv"), ib("deco", gly("U", "text-decoration:underline;font-weight:400"), "Unterstrichen"), ib("deco", "border", "Rahmen"), swatch, ib("deco", "fontcolor", "Schriftfarbe"))))
          + grp("Ausrichtung", col(row(ib("deco", "alignT", "Oben ausrichten"), ib("deco", "alignM", "Zentriert ausrichten"), ib("deco", "alignB", "Unten ausrichten"), ib("deco", "wrap", "Textumbruch")), row(ib("deco", "alignL", "Linksbündig"), ib("deco", "alignC", "Zentriert"), ib("deco", "alignR", "Rechtsbündig"), ib("deco", "merge", "Verbinden und zentrieren"))))
          + grp("Flotte (Funktionen)", ships + col(small("clear", "eraser", "=LEEREN()", { disabled: !setup, title: "Fügt =LEEREN() ein" })))
          + grp("Gefecht (Funktionen)", big("ready", "check", "=BEREIT()", { disabled: !setup, cls: "accent", title: "Fügt =BEREIT() ein" }))
          + grp("Spiel", big("invite", "share", "Einladen", { disabled: !online }) + big("new", "newdoc", "Neues Spiel") + big("resign", "flag", "Aufgeben", { disabled: ph === "none" || ph === "finished", cls: "danger" }))
          + grp("Formatvorlagen", big("deco", "cond", "Bedingte Formatierung") + big("styles", "styles", "Zellen&shy;formatvorlagen", { title: "Gut, Schlecht, Neutral – Auswahl einfärben" }));
      }
      case "einfuegen":
        return grp("Tabellen", big("deco", "pivot", "PivotTable") + big("protocol", "table", "Tabelle", { title: "Gefechtsprotokoll öffnen" }))
          + grp("Illustrationen", big("deco", "image", "Bilder") + big("deco", "shapes", "Formen"))
          + grp("Diagramme", big("deco", "chart", "Empfohlene Diagramme") + col(ib("deco", "chart", "Säule"), ib("deco", "pie", "Kreis")))
          + grp("Kommentare", big("deco", "comment", "Kommentar"));
      case "layout":
        return grp("Designs", big("deco", "palette", "Designs"))
          + grp("Seite einrichten", big("deco", "margins", "Seiten&shy;ränder") + big("deco", "orient", "Ausrichtung"))
          + grp("Blattoptionen", col(chk("gridlines", "Gitternetzlinien anzeigen", !$("#app").classList.contains("no-gridlines")), chk("headings", "Überschriften anzeigen", !$("#app").classList.contains("no-headers"))));
      case "formeln":
        return grp("Funktionsbibliothek", big("fx", "fx", "Funktion einfügen") + big("deco", "sum", "AutoSumme"))
          + grp("Berechnung", big("refresh", "refresh", "Jetzt berechnen"));
      case "daten":
        return grp("Abrufen und transformieren", big("refresh", "refresh", "Alle aktualisieren", { title: "Spielstand neu laden" }))
          + grp("Sortieren und Filtern", big("deco", "sortAZ", "Sortieren") + big("deco", "filter", "Filtern"));
      case "pruefen":
        return grp("Dokumentprüfung", big("deco", "spell", "Rechtschreibung"))
          + grp("Kommentare", big("deco", "comment", "Neuer Kommentar"))
          + grp("Schützen", big("deco", "lock", "Blatt schützen"));
      case "ansicht":
        return grp("Anzeigen", col(chk("gridlines", "Gitternetzlinien", !$("#app").classList.contains("no-gridlines")), chk("headings", "Überschriften", !$("#app").classList.contains("no-headers"))))
          + grp("Zoom", big("zoom100", "zoom", "100 %") + big("zoomin", "zoomIn", "Vergrössern") + big("zoomout", "zoomOut", "Verkleinern"))
          + grp("Fenster", big("deco", "freeze", "Fenster fixieren"));
      case "hilfe":
        return grp("Hilfe", big("help", "help", "Hilfe") + big("protocol", "table", "Protokoll") + big("about", "info", "Info"));
    }
    return "";
  }

  function renderRibbonTabs() {
    $("#ribbonTabs").innerHTML = RIBBON_TABS.map(([k, label]) =>
      `<button class="rtab${k === "datei" ? " file" : ""}${k === App.ribbonTab ? " active" : ""}" data-tab="${k}">${label}</button>`).join("")
      + `<div class="rt-right"><button class="rt-pill" data-cmd="protocol">💬 Protokoll</button><button class="rt-pill share" data-cmd="invite">⇪ Freigeben</button></div>`;
  }

  function renderRibbonIfChanged() {
    const html = ribbonHtml();
    if (html === App.ribbonSig) return;
    App.ribbonSig = html;
    $("#ribbon").innerHTML = html;
  }

  // -------------------------------------------------------------------
  //  Kopfzeile, Blattregister, Statusleiste
  // -------------------------------------------------------------------
  function renderTitle() {
    const s = App.state;
    let name = "Mappe1";
    if (App.session) name = App.session.mode === "local" ? "Versenken_Computer.xlsx" : `Versenken_${App.session.code}.xlsx`;
    $("#docTitle").textContent = name;
    const turn = phase() === "myturn";
    document.title = (turn ? "● Du bist dran – " : "") + name + " - Zellen versenken";
    const nm = (s && s.myName) || store.name || "?";
    $("#avatar").textContent = nm.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
    $("#avatar").title = nm;
  }

  function renderSheetTabs() {
    const dot = phase() === "myturn" && App.sheet !== "gefecht";
    $("#sheetTabs").innerHTML = Object.entries(SHEETS).map(([k, d]) =>
      `<button class="st-tab${k === App.sheet ? " active" : ""}" data-sheet="${k}">${d.name}${k === "gefecht" && dot ? '<span class="dot"></span>' : ""}</button>`).join("");
  }

  function updateStatusbar() {
    const ph = phase();
    $("#sbMode").textContent = { none: "Bereit", setup: "Platzieren", readywait: "Warten", myturn: "Zielen", oppturn: "Warten", finished: "Bereit" }[ph];
    const st = stats();
    $("#sbAgg").textContent = App.state
      ? `Formeln: ${App.fxCount.ok} ✓  ${App.fxCount.bad} ✗    Schüsse: ${st.myShots}    Treffer: ${st.myHits}    Quote: ${pct(st.myHits, st.myShots)}`
      : "";
  }

  let msgTimer = null;
  function setMsg(text, kind) {
    const el = $("#sbMsg");
    el.textContent = text;
    el.className = "sb-msg" + (kind ? " " + kind : "");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.textContent = ""; }, 12000);
  }

  function renderAll() {
    renderTitle();
    renderRibbonIfChanged();
    renderSheetTabs();
    renderSheet();
    if (App.flash && App.sheet === "gefecht" && App.grid) {
      const td = App.grid.td(App.flash.r, App.flash.c);
      if (td) { td.classList.remove("flash"); void td.offsetWidth; td.classList.add("flash"); }
      App.flash = null;
    }
  }

  // -------------------------------------------------------------------
  //  Dialoge & Toast
  // -------------------------------------------------------------------
  function dialog({ title = "Zellen versenken", icon = "ℹ️", html, buttons = [{ label: "OK", value: true, primary: true }], onOpen }) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "dlg-overlay";
      ov.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">
        <div class="dlg-title"><span>${esc(title)}</span><button class="dlg-x" data-v="__x">✕</button></div>
        <div class="dlg-body"><div class="dlg-icon">${icon}</div><div class="dlg-text">${html}</div></div>
        <div class="dlg-btns">${buttons.map((b, i) => `<button class="btn${b.primary ? " primary" : ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
      const close = (v) => { ov.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
        if (e.key === "Enter" && !(e.target && e.target.classList.contains("dlg-link"))) {
          e.preventDefault(); e.stopPropagation();
          const p = buttons.find((b) => b.primary) || buttons[0];
          close(p.value);
        }
      };
      ov.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-i]");
        if (btn) close(buttons[+btn.dataset.i].value);
        else if (e.target.closest("[data-v='__x']")) close(null);
      });
      document.addEventListener("keydown", onKey, true);
      $("#dialogLayer").appendChild(ov);
      if (onOpen) onOpen(ov);
      const pb = $(".btn.primary", ov) || $(".btn", ov);
      if (pb) pb.focus();
    });
  }

  function errorBox(e, title) {
    dialog({ title: title || "Zellen versenken", icon: "⚠️", html: esc(e && e.message ? e.message : String(e)) });
  }

  let toastTimer = null;
  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // -------------------------------------------------------------------
  //  Backstage
  // -------------------------------------------------------------------
  function openBackstage(page = "start") {
    const h = new Date().getHours();
    const nm = store.name;
    $("#bsGreeting").textContent = (h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend") + (nm ? ", " + nm : "");
    $("#playerName").value = nm;
    $("#bsOfflineHint").hidden = !!App.online;
    $$('[data-action="new-online"], [data-action="goto-open"]').forEach((b) => { b.disabled = !App.online; });
    renderRecent();
    showBsPage(page);
    $("#backstage").hidden = false;
  }
  function closeBackstage() { $("#backstage").hidden = true; }
  function showBsPage(page) {
    $$(".bs-page").forEach((p) => { p.hidden = p.dataset.page !== page; });
    $$(".bs-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
    if (page === "oeffnen") setTimeout(() => $("#joinCode").focus(), 30);
  }
  function renderRecent() {
    const list = App.online ? store.sessions() : [];
    const statusTxt = { waiting: "wartet auf Gegner", placing: "Schiffe platzieren", playing: "läuft", finished: "beendet" };
    const html = list.length
      ? list.map((x) => `<button class="recent-row" data-recent="${esc(x.code)}"><span class="ri">▦</span>
          <span><b>Versenken_${esc(x.code)}.xlsx</b><br><span class="rm">${esc(x.name)} vs. ${esc(x.opp || "—")}</span></span>
          <span class="rm">${esc(statusTxt[x.status] || "")}</span>
          <span class="rm">${new Date(x.at).toLocaleDateString("de-CH")}</span></button>`).join("")
      : '<div class="recent-empty">Noch keine Online-Spiele.</div>';
    $("#recentList").innerHTML = html;
    $("#recentList2").innerHTML = html;
  }

  // -------------------------------------------------------------------
  //  Zoom
  // -------------------------------------------------------------------
  function setZoom(z) {
    App.zoom = Math.max(50, Math.min(200, Math.round(z / 10) * 10));
    $("#sheetZoom").style.zoom = App.zoom / 100;
    $("#zoomRange").value = App.zoom;
    $("#zoomLabel").textContent = App.zoom + " %";
    updateSelection();
  }

  // -------------------------------------------------------------------
  //  Befehle
  // -------------------------------------------------------------------
  function runCmd(cmd, el) {
    switch (cmd) {
      case "deco": toast(`«${(el && el.dataset.label) || "Diese Funktion"}» ist während eines Seegefechts nicht verfügbar.`); break;
      case "ship": insertFunction(F.SHIP_FUNC[el.dataset.ship]); break;
      case "clear": insertFunction(F.lookup("LEEREN")); break;
      case "ready": insertFunction(F.lookup("BEREIT")); break;
      case "fill": applyFill(App.fillColor); break;
      case "fillmenu": showFormatMenu(el.closest(".fill-split") || el, "fill"); break;
      case "styles": showFormatMenu(el, "styles"); break;
      case "invite": showInvite(); break;
      case "new": openBackstage("neu"); break;
      case "resign": resignGame(); break;
      case "refresh": refresh(); toast("Spielstand aktualisiert."); break;
      case "fx": showFunctionDialog(); break;
      case "zoom100": setZoom(100); break;
      case "zoomin": setZoom(App.zoom + 10); break;
      case "zoomout": setZoom(App.zoom - 10); break;
      case "help": switchSheet("hilfe"); break;
      case "protocol": switchSheet("protokoll"); break;
      case "about": openBackstage("info"); break;
    }
  }

  async function showFunctionDialog() {
    const html = "<div class='big'>Funktion einfügen</div><div class='fx-list'>"
      + F.FUNCS.map((f, i) => `<button class="fx-row" data-fxi="${i}"><b>${esc(f.name)}</b>(${f.arg ? `<i>${esc(f.arg)}</i>` : ""})<span>${esc(f.desc)}</span></button>`).join("")
      + "</div>";
    let picked = null;
    const v = await dialog({
      icon: "𝑓", title: "Funktion einfügen", html,
      buttons: [{ label: "Schliessen", value: null, primary: true }],
      onOpen: (ov) => ov.addEventListener("click", (e) => {
        const b = e.target.closest("[data-fxi]");
        if (b) { picked = F.FUNCS[+b.dataset.fxi]; $(".dlg-x", ov).click(); }
      }),
    });
    if (picked) insertFunction(picked);
    return v;
  }

  // -------------------------------------------------------------------
  //  Ereignisse
  // -------------------------------------------------------------------
  function bindEvents() {
    // Menüband-Tabs
    $("#ribbonTabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) {
        if (t.dataset.tab === "datei") { openBackstage("start"); return; }
        App.ribbonTab = t.dataset.tab;
        renderRibbonTabs();
        renderRibbonIfChanged();
        return;
      }
      const c = e.target.closest("[data-cmd]");
      if (c) runCmd(c.dataset.cmd, c);
    });
    $("#ribbon").addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      const c = e.target.closest("[data-cmd]");
      if (c && !c.disabled) runCmd(c.dataset.cmd, c);
    });
    $("#ribbon").addEventListener("change", (e) => {
      const cmd = e.target.dataset.cmd;
      if (cmd === "gridlines") $("#app").classList.toggle("no-gridlines", !e.target.checked);
      if (cmd === "headings") $("#app").classList.toggle("no-headers", !e.target.checked);
      App.ribbonSig = "";
      renderRibbonIfChanged();
      updateSelection();
    });
    $$("[data-deco]").forEach((el) => el.addEventListener("click", () => toast(`«${el.dataset.deco}» ist während eines Seegefechts nicht verfügbar.`)));

    // Tabelle
    const grid = $("#grid");
    const fi = $("#formulaInput");
    let dragging = false;
    grid.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td");
      // Zeigemodus: während eine Formel getippt wird, fügt ein Klick den Zellbezug ein
      if (td && document.activeElement === fi && pointInsertAllowed(fi)) {
        e.preventDefault();
        const r = +td.dataset.r, c = +td.dataset.c;
        App.point = App.point && App.point.value === fi.value ? App.point : null;
        if (App.point) App.point.dragging = false;
        pointRef(r, c, r, c);
        App.point.dragging = true;
        App.point.anchor = { r, c };
        return;
      }
      if (td) {
        select(+td.dataset.r, +td.dataset.c, { extend: e.shiftKey });
        dragging = true;
        return;
      }
      const th = e.target.closest("th");
      if (th && th.dataset.col != null) select(App.sel.r, +th.dataset.col);
      else if (th && th.dataset.row != null) select(+th.dataset.row, 1);
    });
    grid.addEventListener("mousemove", (e) => {
      if (!(e.buttons & 1)) { dragging = false; if (App.point) App.point.dragging = false; return; }
      const td = e.target.closest("td");
      if (!td) return;
      const r = +td.dataset.r, c = +td.dataset.c;
      if (App.point && App.point.dragging && document.activeElement === fi) {
        pointRef(App.point.anchor.r, App.point.anchor.c, r, c);
      } else if (dragging) {
        const end = App.selEnd || App.sel;
        if (end.r !== r || end.c !== c) select(r, c, { extend: true });
      }
    });
    document.addEventListener("mouseup", () => { dragging = false; if (App.point) App.point.dragging = false; });
    grid.addEventListener("click", (e) => {
      const td = e.target.closest("td");
      if (!td || App.sheet !== "gefecht" || document.activeElement === fi) return;
      const m = App.grid.get(+td.dataset.r, +td.dataset.c);
      if (m && m.shipRow && phase() === "setup" && !App.draft.ships.some((x) => x.id === m.shipRow)) {
        insertFunction(F.SHIP_FUNC[m.shipRow]);
      }
    });
    grid.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td");
      if (!td) return;
      const b = boardAt(+td.dataset.r, +td.dataset.c);
      if (b && b.who === "opp" && phase() === "myturn") setMsg(`Hier wird nicht geklickt, sondern geschrieben: =FEUER(${oppRef(b.r, b.c)})`);
      if (b && b.who === "me" && phase() === "setup") setMsg("Schiffe platzierst du mit einer Formel, z. B. =KREUZER(E8:G8)");
    });
    grid.addEventListener("contextmenu", (e) => e.preventDefault());

    // Tastatur
    document.addEventListener("keydown", (e) => {
      if (!$("#backstage").hidden) {
        if (e.key === "Escape" && App.session) closeBackstage();
        return;
      }
      if ($("#dialogLayer").children.length) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const g = App.grid;
      const cur = e.shiftKey && App.selEnd ? App.selEnd : App.sel;
      const sp = g.spanOf(cur.r, cur.c);
      const ext = e.shiftKey && e.key.startsWith("Arrow");
      const move = (r, c) => { e.preventDefault(); select(r, c, { scroll: true, extend: ext }); };
      switch (e.key) {
        case "ArrowRight": return move(sp.r, sp.c + sp.cs);
        case "ArrowLeft": return move(sp.r, sp.c - 1);
        case "ArrowDown": return move(sp.r + sp.rs, sp.c);
        case "ArrowUp": return move(sp.r - 1, sp.c);
        case "Tab": return move(sp.r, e.shiftKey ? sp.c - 1 : sp.c + sp.cs);
        case "Enter": return move(e.shiftKey ? sp.r - 1 : sp.r + sp.rs, sp.c);
        case "F2": e.preventDefault(); editFormula(fi.value); return;
        case "Delete": case "Backspace":
          e.preventDefault();
          toast("Inhalte sind geschützt. Füllfarbe entfernen: Start → Füllfarbe → Keine Füllung.");
          return;
      }
      // Wie in der Tabellenkalkulation: Tippen startet die Eingabe
      if (e.key.length === 1) { e.preventDefault(); editFormula(e.key); }
    });

    // Namenfeld
    const nb = $("#nameBox");
    nb.addEventListener("focus", () => nb.select());
    nb.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const p = parseRef(nb.value);
        nb.blur();
        if (p && p.r < App.grid.nR && p.c < App.grid.nC) select(p.r, p.c, { scroll: true });
        else { updateSelection(); toast("Ungültiger Bezug."); }
      } else if (e.key === "Escape") { nb.blur(); updateSelection(); }
    });

    // Bearbeitungsleiste
    const finish = () => { hidePopup(); App.point = null; fi.blur(); App.typed = null; updateSelection(); renderSheet(); };
    fi.addEventListener("keydown", (e) => {
      const popOpen = !$("#fxPopup").hidden && fxPop.items.length;
      if (popOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        fxPop.active = (fxPop.active + (e.key === "ArrowDown" ? 1 : fxPop.items.length - 1)) % fxPop.items.length;
        onFormulaInput();
        return;
      }
      if (popOpen && e.key === "Tab") { e.preventDefault(); acceptCompletion(fxPop.active); return; }
      if (e.key === "Enter") { e.preventDefault(); const v = fi.value; finish(); runFormula(v); }
      else if (e.key === "Escape") { if (popOpen) hidePopup(); else finish(); }
    });
    fi.addEventListener("input", () => { App.point = null; onFormulaInput(); });
    fi.addEventListener("click", () => onFormulaInput());
    fi.addEventListener("focus", () => onFormulaInput());
    fi.addEventListener("blur", () => setTimeout(() => {
      if (document.activeElement !== fi) { hidePopup(); App.point = null; App.typed = null; renderSheet(); }
    }, 0));
    $("#fxPopup").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const it = e.target.closest("[data-fx]");
      if (it) acceptCompletion(+it.dataset.fx);
    });
    $("#fbOk").addEventListener("mousedown", (e) => e.preventDefault());
    $("#fbOk").addEventListener("click", () => { const v = fi.value; finish(); runFormula(v); });
    $("#fbCancel").addEventListener("mousedown", (e) => e.preventDefault());
    $("#fbCancel").addEventListener("click", finish);
    $(".fb-fx").addEventListener("click", () => runCmd("fx"));

    // Blattregister
    $("#sheetTabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-sheet]");
      if (t) switchSheet(t.dataset.sheet);
    });

    // Zoom
    $("#zoomRange").addEventListener("input", (e) => setZoom(+e.target.value));
    $("#zoomIn").addEventListener("click", () => setZoom(App.zoom + 10));
    $("#zoomOut").addEventListener("click", () => setZoom(App.zoom - 10));
    $("#sheetScroll").addEventListener("wheel", (e) => {
      if (e.ctrlKey) { e.preventDefault(); setZoom(App.zoom + (e.deltaY < 0 ? 10 : -10)); }
    }, { passive: false });

    // Backstage
    $("#backstage").addEventListener("click", (e) => {
      const item = e.target.closest(".bs-item");
      if (item) { showBsPage(item.dataset.page); return; }
      if (e.target.closest("#bsBack")) { if (App.session) closeBackstage(); else toast("Starte zuerst ein Spiel."); return; }
      const a = e.target.closest("[data-action]");
      if (a && !a.disabled) {
        const act = a.dataset.action;
        if (act === "new-online") newOnline();
        if (act === "new-local") newLocal();
        if (act === "goto-open") showBsPage("oeffnen");
        if (act === "join") joinGame($("#joinCode").value);
        return;
      }
      const rec = e.target.closest("[data-recent]");
      if (rec) { const s = store.find(rec.dataset.recent); if (s) resume(s); }
    });
    $("#joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(e.target.value); });
    $("#playerName").addEventListener("change", (e) => {
      store.name = e.target.value.trim();
      openBackstage($(".bs-item.active") ? $(".bs-item.active").dataset.page : "start");
    });

    window.addEventListener("resize", updateSelection);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && App.session) refresh(); });
  }

  // -------------------------------------------------------------------
  //  Start
  // -------------------------------------------------------------------
  function init() {
    const cfg = window.ZV_CONFIG || {};
    if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase) {
      try { App.online = new OnlineBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY); } catch (e) { console.error(e); }
    }
    renderRibbonTabs();
    bindEvents();
    App.sel = { r: BR0, c: ME_C0 };
    renderAll();

    const code = new URLSearchParams(location.search).get("spiel");
    if (code) {
      const known = store.find(code);
      if (known && App.online) { resume(known); return; }
      openBackstage("oeffnen");
      $("#joinCode").value = code.toUpperCase();
      if (!store.name) setTimeout(() => { showBsPage("start"); $("#playerName").focus(); toast(`Gib deinen Namen ein und tritt dann Spiel ${code.toUpperCase()} bei.`); }, 50);
      return;
    }
    openBackstage("start");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
