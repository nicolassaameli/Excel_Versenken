// Gemeinsame Spiellogik (Flotte, Koordinaten, Platzierung)
(function () {
  const SIZE = 10;
  const LETTERS = "ABCDEFGHIJ";

  // Muss mit der Prüfung in supabase/schema.sql (submit_ships) übereinstimmen.
  const FLEET = [
    { id: "traeger", name: "Flugzeugträger", len: 5 },
    { id: "schlachtschiff", name: "Schlachtschiff", len: 4 },
    { id: "kreuzer", name: "Kreuzer", len: 3 },
    { id: "uboot", name: "U-Boot", len: 3 },
    { id: "zerstoerer", name: "Zerstörer", len: 2 },
  ];
  const FLEET_BY_ID = Object.fromEntries(FLEET.map((s) => [s.id, s]));
  const TOTAL_CELLS = FLEET.reduce((a, s) => a + s.len, 0);

  function shipCells(ship) {
    const cells = [];
    for (let i = 0; i < ship.len; i++) {
      cells.push(ship.dir === "h" ? { r: ship.r, c: ship.c + i } : { r: ship.r + i, c: ship.c });
    }
    return cells;
  }

  function inBounds(ship) {
    return shipCells(ship).every((p) => p.r >= 0 && p.r < SIZE && p.c >= 0 && p.c < SIZE);
  }

  function overlaps(ship, others) {
    const taken = new Set();
    others.forEach((o) => { if (o.id !== ship.id) shipCells(o).forEach((p) => taken.add(p.r * SIZE + p.c)); });
    return shipCells(ship).some((p) => taken.has(p.r * SIZE + p.c));
  }

  function canPlace(ship, others) {
    return inBounds(ship) && !overlaps(ship, others);
  }

  function shipAt(ships, r, c) {
    return ships.find((s) => shipCells(s).some((p) => p.r === r && p.c === c)) || null;
  }

  function randomFleet() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const ships = [];
      let ok = true;
      for (const def of FLEET) {
        let placed = false;
        for (let t = 0; t < 200 && !placed; t++) {
          const dir = Math.random() < 0.5 ? "h" : "v";
          const ship = {
            id: def.id, len: def.len, dir,
            r: Math.floor(Math.random() * (dir === "v" ? SIZE - def.len + 1 : SIZE)),
            c: Math.floor(Math.random() * (dir === "h" ? SIZE - def.len + 1 : SIZE)),
          };
          if (canPlace(ship, ships)) { ships.push(ship); placed = true; }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return ships;
    }
    throw new Error("Zufällige Platzierung fehlgeschlagen");
  }

  function isCompleteFleet(ships) {
    return FLEET.every((def) => {
      const s = ships.find((x) => x.id === def.id);
      return s && s.len === def.len && canPlace(s, ships);
    });
  }

  function coord(r, c) {
    return LETTERS[c] + (r + 1);
  }

  function parseCoord(text) {
    const m = /^\s*"?\s*([A-Ja-j])\s*(10|[1-9])\s*"?\s*$/.exec(text || "");
    if (!m) return null;
    return { r: parseInt(m[2], 10) - 1, c: LETTERS.indexOf(m[1].toUpperCase()) };
  }

  // Serverantwort (oder lokale Antwort) in ein einheitliches Format bringen
  function normalizeState(raw) {
    const g = raw.game;
    const seat = raw.seat;
    const opp = 3 - seat;
    return {
      code: g.code,
      status: g.status,
      seat,
      turn: g.turn,
      winner: g.winner,
      resigned: !!g.resigned,
      myName: g["p" + seat + "_name"],
      oppName: g["p" + opp + "_name"],
      myReady: !!g["p" + seat + "_ready"],
      oppReady: !!g["p" + opp + "_ready"],
      myShips: raw.my_ships || [],
      myShots: raw.my_shots || [],
      oppShots: raw.opp_shots || [],
      oppShips: raw.opp_ships || [],
      scansCount: g.scans_count || 0,
      lastScan: g.last_scan || null,
      updatedAt: g.updated_at,
    };
  }

  window.ZV = {
    SIZE, LETTERS, FLEET, FLEET_BY_ID, TOTAL_CELLS,
    shipCells, inBounds, canPlace, shipAt, randomFleet, isCompleteFleet,
    coord, parseCoord, normalizeState,
  };
})();
