// =====================================================================
//  Zellen versenken – Formel-Parser
//  Prüft die Schreibweise von Formeln wie =FLUGZEUGTRÄGER(C6:G6) oder
//  =FEUER(Q8) und liefert verständliche Fehlermeldungen im Excel-Stil.
//  Ob ein Bezug im richtigen Feld liegt, prüft app.js.
// =====================================================================
(function () {
  "use strict";
  const { FLEET } = window.ZV;

  // Gross-/Kleinschreibung egal, Ä = AE usw. (wie Excel bei Funktionsnamen tolerant)
  const norm = (s) => String(s || "").toUpperCase()
    .replace(/Ä/g, "AE").replace(/Ö/g, "OE").replace(/Ü/g, "UE").replace(/ß/g, "SS")
    .replace(/[^A-Z0-9]/g, "");

  const SHIP_FN = { traeger: "FLUGZEUGTRÄGER", schlachtschiff: "SCHLACHTSCHIFF", kreuzer: "KREUZER", uboot: "UBOOT", zerstoerer: "ZERSTÖRER" };
  const SHIP_EX = { traeger: "C6:G6", schlachtschiff: "E8:E11", kreuzer: "G13:I13", uboot: "L6:L8", zerstoerer: "J10:K10" };

  const FUNCS = [
    ...FLEET.map((s) => ({
      name: SHIP_FN[s.id], kind: "ship", ship: s.id, len: s.len, arg: "Bereich",
      desc: `Platziert ${s.id === "uboot" ? "das" : "den"} ${s.name} in deinem Feld (C6:L15).`,
      argHint: `${s.len} Zellen in einer Zeile oder Spalte, z. B. ${SHIP_EX[s.id]}`,
      example: `=${SHIP_FN[s.id]}(${SHIP_EX[s.id]})`,
    })),
    { name: "FEUER", kind: "fire", arg: "Zelle", desc: "Schiesst auf eine Zelle im gegnerischen Feld (O6:X15).",
      argHint: "eine einzelne Zelle im gegnerischen Feld, z. B. Q8", example: "=FEUER(Q8)" },
    { name: "SUCHEN", kind: "scan", arg: "Bereich", desc: "Sucht 2×2 Zellen im gegnerischen Feld ab. Das Ergebnis erscheint nur kurz – markiere es dir mit einer Füllfarbe! Kostet den Zug.",
      argHint: "genau 2×2 Zellen im gegnerischen Feld, z. B. Q8:R9", example: "=SUCHEN(Q8:R9)" },
    { name: "BEREIT", kind: "ready", arg: null, desc: "Gibt deine Flotte ab, wenn alle fünf Schiffe liegen.", example: "=BEREIT()" },
    { name: "LEEREN", kind: "clear", arg: null, desc: "Entfernt alle Schiffe aus deinem Feld.", example: "=LEEREN()" },
    { name: "HILFE", kind: "help", arg: null, desc: "Öffnet das Blatt «Hilfe».", example: "=HILFE()" },
  ];
  const BY_NORM = Object.fromEntries(FUNCS.map((f) => [norm(f.name), f]));
  const SHIP_FUNC = Object.fromEntries(FUNCS.filter((f) => f.kind === "ship").map((f) => [f.ship, f]));

  function lookup(name) { return BY_NORM[norm(name)] || null; }

  function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }

  function suggest(name) {
    const n = norm(name);
    if (!n) return null;
    let best = null, bestD = Infinity;
    for (const f of FUNCS) {
      const fn = norm(f.name);
      const dist = fn.startsWith(n) && n.length >= 3 ? 0.5 : levenshtein(n, fn);
      if (dist < bestD) { bestD = dist; best = f; }
    }
    return bestD <= Math.max(2, Math.floor(norm(best.name).length / 3)) ? best : null;
  }

  // Funktionen, deren Name mit dem Getippten beginnt (für die Autovervollständigung)
  function complete(prefix) {
    const n = norm(prefix);
    if (!n) return [];
    return FUNCS.filter((f) => norm(f.name).startsWith(n));
  }

  function colName(i) {
    let s = "";
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  const REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
  function parseRef(s) {
    const m = REF_RE.exec(String(s).trim());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    const r = parseInt(m[2], 10) - 1;
    if (r < 0) return null;
    return { r, c: c - 1 };
  }
  const refText = (p) => colName(p.c) + (p.r + 1);

  const err = (code, msg, fix) => ({ ok: false, code, msg, fix: fix || null });

  // Ein Argument als Zellbezug oder Bereich lesen
  function parseArg(raw, f) {
    const a = raw.trim();
    if (!a) return err("#WERT!", `${f.name} braucht ${f.arg === "Bereich" ? "einen Bereich" : "einen Zellbezug"} in der Klammer.`, f.example);
    if (/^["'].*["']$/.test(a)) {
      const inner = a.slice(1, -1);
      return err("#WERT!", `Zellbezüge schreibt man ohne Anführungszeichen. Mit "${inner}" wird nur ein Text übergeben, kein Bezug.`,
        `=${f.name}(${inner.toUpperCase()})`);
    }
    // Falsche Trennzeichen in Bereichen: C6-G6, C6..G6, C6 G6
    const sep = /^(\$?[A-Za-z]{1,3}\$?\d+)\s*(-|\.{1,3}|–|\s)\s*(\$?[A-Za-z]{1,3}\$?\d+)$/.exec(a);
    if (sep) {
      return err("#BEZUG!", `Einen Bereich schreibt man mit Doppelpunkt zwischen erster und letzter Zelle – nicht mit «${sep[2].trim() || "Leerzeichen"}».`,
        `=${f.name}(${sep[1].toUpperCase()}:${sep[3].toUpperCase()})`);
    }
    const parts = a.split(/\s*:\s*/);
    if (parts.length > 2) return err("#BEZUG!", "Ein Bereich hat genau einen Doppelpunkt: erste Zelle:letzte Zelle.", f.example);
    const refs = [];
    for (const p of parts) {
      const ref = parseRef(p);
      if (!ref) {
        if (/^\d+[A-Za-z]+$/.test(p.trim())) {
          const m = /^(\d+)([A-Za-z]+)$/.exec(p.trim());
          return err("#BEZUG!", `«${p.trim()}» ist kein Zellbezug: Zuerst kommt der Spaltenbuchstabe, dann die Zeilennummer.`,
            `=${f.name}(${a.replace(p.trim(), m[2].toUpperCase() + m[1])})`);
        }
        return err("#BEZUG!", `«${p.trim() || a}» ist kein gültiger Zellbezug. Ein Bezug besteht aus Spaltenbuchstabe und Zeilennummer, z. B. ${f.kind === "fire" ? "Q8" : "C6"}.`, f.example);
      }
      refs.push(ref);
    }
    if (f.arg === "Zelle" && refs.length > 1) {
      return err("#WERT!", `${f.name} erwartet eine einzelne Zelle, keinen Bereich.`, `=${f.name}(${refText(refs[0])})`);
    }
    if (refs.length === 1) refs.push(refs[0]);
    const r0 = Math.min(refs[0].r, refs[1].r), r1 = Math.max(refs[0].r, refs[1].r);
    const c0 = Math.min(refs[0].c, refs[1].c), c1 = Math.max(refs[0].c, refs[1].c);
    const text = r0 === r1 && c0 === c1 ? refText({ r: r0, c: c0 }) : refText({ r: r0, c: c0 }) + ":" + refText({ r: r1, c: c1 });
    return { ok: true, r0, c0, r1, c1, text };
  }

  // Hauptfunktion: Formeltext → { ok, f, arg } oder { ok:false, code, msg, fix }
  function parse(input) {
    const t = String(input || "").trim();
    if (!t) return err("", "");
    if (!t.startsWith("=")) {
      const asFn = /^([A-Za-zÄÖÜäöüß_.]+)\s*\(/.exec(t);
      const fn = asFn && lookup(asFn[1]);
      if (fn) return err("Kein =", "Jede Formel beginnt mit einem Gleichheitszeichen. Ohne «=» ist es nur Text.", "=" + t);
      if (parseRef(t)) return err("Kein =", `«${t}» ist nur ein Zellbezug. Um darauf zu schiessen, brauchst du die Funktion FEUER.`, `=FEUER(${t.toUpperCase()})`);
      return err("Kein =", "Diese Zelle ist geschützt. Hier funktionieren nur Formeln – und jede Formel beginnt mit «=».", "=FEUER(Q8)");
    }
    const body = t.slice(1).trim();
    const open = body.indexOf("(");
    const rawName = (open >= 0 ? body.slice(0, open) : body).trim();

    if (!rawName) return err("#NAME?", "Nach dem «=» fehlt der Funktionsname.", "=FEUER(Q8)");
    const f = lookup(rawName);
    if (!f || !/^[A-Za-zÄÖÜäöüß_.]+$/.test(rawName)) {
      const s = suggest(rawName);
      let msg = `Die Funktion «${rawName}» gibt es nicht.`;
      if (/[-\s]/.test(rawName)) msg += " Funktionsnamen enthalten keine Leer- oder Bindestriche.";
      const fix = s ? (open >= 0 ? `=${s.name}${body.slice(open)}` : s.example) : null;
      return err("#NAME?", msg + (s ? ` Meintest du ${s.name}?` : " Eine Liste aller Funktionen findest du unter 𝑓x."), fix);
    }
    if (open < 0) {
      return err("Fehlende Klammer", `Nach dem Funktionsnamen ${f.name} folgt eine Klammer «(» – auch wenn sie leer bleibt.`, f.example);
    }
    const rest = body.slice(open + 1);
    const close = rest.lastIndexOf(")");
    if (close < 0) {
      return err("Fehlende Klammer", "Es fehlt die schliessende Klammer «)». Jede geöffnete Klammer muss auch geschlossen werden.",
        `=${f.name}(${rest.trim()})`);
    }
    const after = rest.slice(close + 1).trim();
    if (after) return err("Problem", `Nach der schliessenden Klammer darf nichts mehr stehen («${after}»).`, `=${f.name}(${rest.slice(0, close).trim()})`);
    const inner = rest.slice(0, close);
    if (/[()]/.test(inner)) return err("Problem", "Zu viele Klammern. In diese Funktion gehört nur ein Bezug.", f.example);

    if (!f.arg) {
      if (inner.trim()) return err("#WERT!", `${f.name} hat keine Argumente – die Klammer bleibt leer.`, `=${f.name}()`);
      return { ok: true, f, arg: null };
    }
    const args = inner.split(/[;,]/);
    if (args.length > 1) {
      const both = args.length === 2 && parseRef(args[0]) && parseRef(args[1]);
      if (both && f.arg === "Bereich") {
        return err("#WERT!", "Ein Bereich wird mit Doppelpunkt geschrieben: erste Zelle:letzte Zelle. Ein «;» trennt zwei verschiedene Argumente.",
          `=${f.name}(${args[0].trim().toUpperCase()}:${args[1].trim().toUpperCase()})`);
      }
      return err("#WERT!", `${f.name} braucht genau ein Argument: ${f.argHint}.`, f.example);
    }
    const arg = parseArg(args[0], f);
    if (!arg.ok) return arg;
    return { ok: true, f, arg };
  }

  window.ZVFormula = { FUNCS, SHIP_FUNC, lookup, complete, parse, parseRef, refText, colName, norm };
})();
