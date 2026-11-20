// Zwei austauschbare Backends mit identischer Schnittstelle:
//   create(name) / join(code, name) -> session {code, token, seat, mode}
//   getState(session) -> Rohzustand (wie get_state in SQL)
//   submitShips(session, ships) / fire(session, r, c) / scan(session, r, c) / resign(session)
//   subscribe(session, onChange) -> unsubscribe()
(function () {
  const { SIZE, shipCells, randomFleet, isCompleteFleet } = window.ZV;

  // ------------------------------------------------------------------
  //  Online (Supabase)
  // ------------------------------------------------------------------
  class OnlineBackend {
    constructor(url, key) {
      this.mode = "online";
      this.sb = window.supabase.createClient(url, key);
    }
    async rpc(fn, args) {
      const { data, error } = await this.sb.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    }
    async create(name) {
      return { ...(await this.rpc("create_game", { p_name: name })), mode: "online" };
    }
    async join(code, name) {
      return { ...(await this.rpc("join_game", { p_code: code, p_name: name })), mode: "online" };
    }
    getState(s) {
      return this.rpc("get_state", { p_code: s.code, p_token: s.token });
    }
    submitShips(s, ships) {
      return this.rpc("submit_ships", { p_code: s.code, p_token: s.token, p_ships: ships });
    }
    fire(s, r, c) {
      return this.rpc("fire", { p_code: s.code, p_token: s.token, p_r: r, p_c: c });
    }
    scan(s, r, c) {
      return this.rpc("scan", { p_code: s.code, p_token: s.token, p_r: r, p_c: c });
    }
    resign(s) {
      return this.rpc("resign", { p_code: s.code, p_token: s.token });
    }
    subscribe(s, onChange) {
      const channel = this.sb
        .channel("game-" + s.code)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "games", filter: "code=eq." + s.code },
          () => onChange())
        .subscribe();
      // Fallback, falls Realtime einmal ein Ereignis verpasst
      const timer = setInterval(onChange, 5000);
      return () => { clearInterval(timer); this.sb.removeChannel(channel); };
    }
  }

  // ------------------------------------------------------------------
  //  Lokal gegen den Computer (gleiche Regeln wie der Server)
  // ------------------------------------------------------------------
  class LocalBackend {
    constructor() {
      this.mode = "local";
      this.onChange = null;
    }
    async create(name) {
      this.seq = 0;
      this.game = {
        code: "LOKAL", status: "placing",
        p1_name: name || "Spieler 1", p2_name: "Computer",
        p1_ready: false, p2_ready: true,
        turn: null, winner: null, resigned: false, shots_count: 0, scans_count: 0, last_scan: null,
        updated_at: new Date().toISOString(),
      };
      this.ships = { 1: null, 2: randomFleet() };
      this.shots = [];
      return { code: "LOKAL", token: "local", seat: 1, mode: "local" };
    }
    async join() { throw new Error("Lokale Spiele können nicht beigetreten werden."); }

    async getState() {
      const g = this.game;
      const myShots = this.shots.filter((s) => s.seat === 1);
      const sunkIds = myShots.filter((s) => s.sunk).map((s) => s.sunk);
      return JSON.parse(JSON.stringify({
        game: g,
        seat: 1,
        my_ships: this.ships[1] || [],
        my_shots: myShots,
        opp_shots: this.shots.filter((s) => s.seat === 2),
        opp_ships: this.ships[2].filter((s) => g.status === "finished" || sunkIds.includes(s.id)),
      }));
    }

    async submitShips(_s, ships) {
      if (!isCompleteFleet(ships)) throw new Error("Ungültige Flotte.");
      this.ships[1] = JSON.parse(JSON.stringify(ships));
      this.game.p1_ready = true;
      this.game.status = "playing";
      this.game.turn = Math.random() < 0.5 ? 1 : 2;
      this._changed();
      if (this.game.turn === 2) this._scheduleAI();
      return { ok: true };
    }

    async fire(_s, r, c) {
      const res = this._fire(1, r, c);
      if (this.game.status === "playing" && this.game.turn === 2) this._scheduleAI();
      return res;
    }

    async scan(_s, r, c) {
      const g = this.game;
      if (g.status !== "playing") throw new Error("Das Spiel läuft nicht.");
      if (g.turn !== 1) throw new Error("Du bist nicht am Zug.");
      if (r < 0 || r > SIZE - 2 || c < 0 || c > SIZE - 2) throw new Error("Ungültiger Suchbereich.");
      const cells = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([dr, dc]) => ({
        r: r + dr, c: c + dc,
        ship: this.ships[2].some((s) => shipCells(s).some((p) => p.r === r + dr && p.c === c + dc)),
      }));
      g.turn = 2;
      g.scans_count++;
      g.last_scan = { seat: 1, r, c };
      this._changed();
      this._scheduleAI();
      return { cells };
    }

    async resign() {
      if (this.game.status !== "finished") {
        Object.assign(this.game, { status: "finished", winner: 2, resigned: true });
        this._changed();
      }
      return { ok: true };
    }

    subscribe(_s, onChange) {
      this.onChange = onChange;
      return () => { this.onChange = null; clearTimeout(this.aiTimer); };
    }

    _changed() {
      this.game.updated_at = new Date().toISOString();
      if (this.onChange) setTimeout(this.onChange, 0);
    }

    _fire(seat, r, c) {
      const g = this.game;
      if (g.status !== "playing") throw new Error("Das Spiel läuft nicht.");
      if (g.turn !== seat) throw new Error("Du bist nicht am Zug.");
      if (this.shots.some((s) => s.seat === seat && s.r === r && s.c === c)) {
        throw new Error("Auf diese Zelle hast du schon geschossen.");
      }
      const target = this.ships[3 - seat];
      const ship = target.find((s) => shipCells(s).some((p) => p.r === r && p.c === c));
      const shot = { id: ++this.seq, seat, r, c, hit: !!ship, sunk: null, t: new Date().toISOString() };
      this.shots.push(shot);
      let win = false;
      if (ship) {
        const mine = this.shots.filter((s) => s.seat === seat && s.hit);
        const hitsOnShip = mine.filter((s) => shipCells(ship).some((p) => p.r === s.r && p.c === s.c)).length;
        if (hitsOnShip === ship.len) shot.sunk = ship.id;
        win = mine.length >= target.reduce((a, s) => a + s.len, 0);
      }
      g.shots_count++;
      if (win) { g.status = "finished"; g.winner = seat; }
      else if (!ship) g.turn = 3 - seat;
      this._changed();
      return { hit: !!ship, sunk: shot.sunk, win };
    }

    _scheduleAI() {
      clearTimeout(this.aiTimer);
      this.aiTimer = setTimeout(() => {
        if (this.game.status !== "playing" || this.game.turn !== 2) return;
        const { r, c } = this._aiPick();
        this._fire(2, r, c);
        if (this.game.status === "playing" && this.game.turn === 2) this._scheduleAI();
      }, 650 + Math.random() * 600);
    }

    // Jagen & Zielen: offene Treffer verfolgen, sonst Schachbrettmuster
    _aiPick() {
      const shots = this.shots.filter((s) => s.seat === 2);
      const shotSet = new Set(shots.map((s) => s.r * SIZE + s.c));
      const free = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && !shotSet.has(r * SIZE + c);

      const sunkCells = new Set();
      shots.filter((s) => s.sunk).forEach((s) => {
        const ship = this.ships[1].find((x) => x.id === s.sunk);
        shipCells(ship).forEach((p) => sunkCells.add(p.r * SIZE + p.c));
      });
      const open = shots.filter((s) => s.hit && !sunkCells.has(s.r * SIZE + s.c));
      const openSet = new Set(open.map((s) => s.r * SIZE + s.c));

      if (open.length) {
        const line = [];
        const around = [];
        for (const h of open) {
          for (const [dr, dc] of [[0, 1], [1, 0]]) {
            if (openSet.has((h.r + dr) * SIZE + (h.c + dc)) || openSet.has((h.r - dr) * SIZE + (h.c - dc))) {
              // Linie verlängern
              let r = h.r, c = h.c;
              while (openSet.has(r * SIZE + c)) { r += dr; c += dc; }
              if (free(r, c)) line.push({ r, c });
              r = h.r; c = h.c;
              while (openSet.has(r * SIZE + c)) { r -= dr; c -= dc; }
              if (free(r, c)) line.push({ r, c });
            }
          }
          for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
            if (free(h.r + dr, h.c + dc)) around.push({ r: h.r + dr, c: h.c + dc });
          }
        }
        const pool = line.length ? line : around;
        if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      }

      const cand = [];
      const fallback = [];
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (!free(r, c)) continue;
          fallback.push({ r, c });
          if ((r + c) % 2 === 0) cand.push({ r, c });
        }
      }
      const pool = cand.length ? cand : fallback;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  window.ZVBackends = { OnlineBackend, LocalBackend };
})();
