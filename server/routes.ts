import express, { Request, Response, NextFunction } from "express";
import pool from "./db/db";
import QRCode from "qrcode";
import bcrypt from "bcrypt";

const router = express.Router();


// ==================
// CSRF CHECK
// ==================

function checkCsrf(req: Request, res: Response, next: NextFunction) {
  if (!req.body) return next(); // geen body, skip
  const token = req.body._csrf;
  if (!token || token !== (req.session as any).csrfToken) {
    return res.status(403).send("Ongeldige CSRF token");
  }
  next();
}

// ==================
// HELPER FUNCTIES
// ==================

function getSelectedMovie(req: Request) {
  return (req.session as any).selectedMovie || null;
}

function getSelectedSeats(req: Request) {
  return (req.session as any).selectedSeats || [];
}

function ensureMovie(req: Request, res: Response, next: NextFunction) {
  if (!getSelectedMovie(req)) return res.redirect("/movies");
  return next();
}

function ensureSeats(req: Request, res: Response, next: NextFunction) {
  if (!getSelectedMovie(req) || getSelectedSeats(req).length === 0)
    return res.redirect("/seats");
  return next();
}

function ensureReservation(req: Request, res: Response, next: NextFunction) {
  if (!(req.session as any).reservation) return res.redirect("/confirm");
  return next();
}

// ==================
// KLANT ROUTES
// ==================
// Login pagina
router.get("/login", (req: Request, res: Response) => {
  res.render("login", { title: "Inloggen", error: null });
});

// Login verwerken
router.post("/login", checkCsrf, async (req: Request, res: Response) => {
  const { email, password } = req.body;
  console.log("EMAIL:", email);
  console.log("ADMIN_USERNAME:", process.env.ADMIN_USERNAME);
  console.log("MATCH:", email === process.env.ADMIN_USERNAME);
  // Check of het de admin is
  if (
    email === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    (req.session as any).isAdmin = true;
    return res.redirect("/admin");
  }

  // Check klant in database
  const { rows } = await pool.query(
    "SELECT * FROM klanten WHERE email = $1",
    [email]
  );

  if (rows.length === 0) {
    return res.render("login", { title: "Inloggen", error: "Onbekend e-mailadres" });
  }

  const klant = rows[0];

  if (!klant.wachtwoord) {
    return res.render("login", { title: "Inloggen", error: "Dit account heeft nog geen wachtwoord. Registreer opnieuw." });
  }

  const match = await bcrypt.compare(password, klant.wachtwoord);
  if (!match) {
    return res.render("login", { title: "Inloggen", error: "Fout wachtwoord" });
  }

  (req.session as any).klant = { id: klant.id, naam: klant.naam, email: klant.email };
  return res.redirect("/movies");
});

// Registreer pagina
router.get("/registreer", (req: Request, res: Response) => {
  res.render("registreer", { title: "Registreren", error: null });
});

// Registreer verwerken
router.post("/registreer", checkCsrf, async (req: Request, res: Response) => {
  const { naam, email, password } = req.body;

  // Check of email al bestaat
  const { rows: bestaand } = await pool.query(
    "SELECT id FROM klanten WHERE email = $1",
    [email]
  );

  if (bestaand.length > 0) {
    return res.render("registreer", { title: "Registreren", error: "Dit e-mailadres is al in gebruik" });
  }

  const hash = await bcrypt.hash(password, 10);

  const { rows } = await pool.query(
    "INSERT INTO klanten (naam, email, wachtwoord) VALUES ($1, $2, $3) RETURNING id, naam, email",
    [naam, email, hash]
  );

  (req.session as any).klant = { id: rows[0].id, naam: rows[0].naam, email: rows[0].email };
  return res.redirect("/movies");
});

// Uitloggen klant
router.get("/logout", (req: Request, res: Response) => {
  (req.session as any).klant = null;
  res.redirect("/");
});

router.get("/", (req: Request, res: Response) => {
  res.render("home", { title: "Cinegraaf" });
});
//FILMROUTES  


router.get("/movies", async (req: Request, res: Response) => {
  try {
    const search = ((req.query.search as string) || "").trim().toLowerCase();
    const genre = ((req.query.genre as string) || "").trim();

    const { rows: films } = await pool.query(`
      SELECT f.*, v.start_tijd, v.prijs, v.id as vertoning_id, z.naam as zaal_naam
      FROM films f
      JOIN vertoningen v ON v.film_id = f.id
      JOIN zalen z ON z.id = v.zaal_id
      WHERE v.start_tijd > NOW()
      ORDER BY v.start_tijd ASC
    `);

    const genres: string[] = [...new Set(films.map((f: any) => f.genre))];

    const filteredFilms = films.filter((f: any) => {
      const inSearch = !search || f.titel.toLowerCase().includes(search);
      const inGenre = !genre || f.genre === genre;
      return inSearch && inGenre;
    });

    res.render("movies", { title: "Films", movies: filteredFilms, search, genre, genres });
  } catch (err) {
    console.error(err);
    res.status(500).send("Fout: " + err);
  }
});

router.post("/movies/select", checkCsrf, async (req: Request, res: Response) => {
  const { movieId } = req.body;
  const { rows } = await pool.query(`
    SELECT f.*, v.start_tijd, v.prijs, v.id as vertoning_id, z.naam as zaal_naam, z.rijen, z.stoelen_per_rij
    FROM films f
    JOIN vertoningen v ON v.film_id = f.id
    JOIN zalen z ON z.id = v.zaal_id
    WHERE v.id = $1
  `, [movieId]);

  if (rows.length === 0) return res.redirect("/movies");

  (req.session as any).selectedMovie = rows[0];
  (req.session as any).selectedSeats = [];
  (req.session as any).reservation = null;

  return res.redirect("/seats");
});

router.get("/seats", ensureMovie, async (req: Request, res: Response) => {
  const movie = getSelectedMovie(req);
  const selectedSeats = getSelectedSeats(req);

  const { rows: bezet } = await pool.query(`
    SELECT gs.rij, gs.stoel
    FROM gereserveerde_stoelen gs
    JOIN boekingen b ON b.id = gs.boeking_id
    WHERE b.vertoning_id = $1
  `, [movie.vertoning_id]);

  const bezetSet = new Set(bezet.map((s: any) => `${s.rij}-${s.stoel}`));

  const rows = [];
  for (let r = 1; r <= movie.rijen; r++) {
    const seats = [];
    for (let s = 1; s <= movie.stoelen_per_rij; s++) {
      seats.push({
        id: `${movie.vertoning_id}-${r}-${s}`,
        row: r,
        number: s,
        status: bezetSet.has(`${r}-${s}`) ? "taken" : "available",
        price: movie.prijs,
      });
    }
    rows.push({ row: r, seats });
  }

  res.render("seats", {
    title: "Stoelen",
    movie,
    rows,
    selectedSeats,
    selectedIds: new Set(selectedSeats.map((e: any) => e.seat.id)),
    total: selectedSeats.reduce((sum: number, e: any) => sum + e.seat.price, 0),
  });
});

router.post("/seats", checkCsrf, ensureMovie, (req: Request, res: Response) => {
  const movie = getSelectedMovie(req);
  const selectedSeatIds: string[] = Array.isArray(req.body.seats)
    ? req.body.seats
    : req.body.seats ? [req.body.seats] : [];

  (req.session as any).selectedSeats = selectedSeatIds.map((id) => {
    const parts = id.split("-");
    const row = parseInt(parts[1]);
    const number = parseInt(parts[2]);
    return { seat: { id, row, number, price: parseFloat(movie.prijs) } };
  });

  if (req.body.action === "confirm") return res.redirect("/confirm");
  return res.redirect("/seats");
});

router.get("/confirm", ensureSeats, (req: Request, res: Response) => {
  const movie = getSelectedMovie(req);
  const selectedSeats = getSelectedSeats(req);
  const total = selectedSeats.reduce((sum: number, e: any) => sum + e.seat.price, 0);

  const formattedDate = new Intl.DateTimeFormat("nl-BE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(movie.start_tijd));

  res.render("confirm", { title: "Bevestig", movie, selectedSeats, total, formattedDate });
});

router.post("/confirm", checkCsrf, ensureSeats, async (req: Request, res: Response) => {
  const movie = getSelectedMovie(req);
  const selectedSeats = getSelectedSeats(req);
  const totalPrice = selectedSeats.reduce((sum: number, e: any) => sum + e.seat.price, 0);

  // Gebruik ingelogde klant of formulierdata
  const klantSessie = (req.session as any).klant;
  const naam = klantSessie ? klantSessie.naam : req.body.naam;
  const email = klantSessie ? klantSessie.email : req.body.email;

  const { rows: klanten } = await pool.query(
    `INSERT INTO klanten (naam, email) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET naam = EXCLUDED.naam
     RETURNING id`,
    [naam, email],
  );

  const { rows: boeking } = await pool.query(
    `INSERT INTO boekingen (vertoning_id, klant_id, totaalbedrag) VALUES ($1, $2, $3) RETURNING id`,
    [movie.vertoning_id, klanten[0].id, totalPrice],
  );

  for (const entry of selectedSeats) {
    await pool.query(
      `INSERT INTO gereserveerde_stoelen (boeking_id, rij, stoel) VALUES ($1, $2, $3)`,
      [boeking[0].id, entry.seat.row, entry.seat.number],
    );
  }

  (req.session as any).reservation = {
    movie, seats: selectedSeats, totalPrice,
    naam, email,
    reservationId: Math.random().toString(36).slice(2, 10).toUpperCase(),
  };

  return res.redirect("/payment");
});

router.get("/payment", ensureReservation, (req: Request, res: Response) => {
  const reservation = (req.session as any).reservation;
  const formattedDate = new Intl.DateTimeFormat("nl-BE", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  }).format(new Date(reservation.movie.start_tijd));

  res.render("payment", { title: "Betaling", reservation, formattedDate });
});

router.get("/success", ensureReservation, async (req: Request, res: Response) => {
  const reservation = (req.session as any).reservation;
  const formattedDate = new Intl.DateTimeFormat("nl-BE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(reservation.movie.start_tijd));

  const qrDataUrl = await QRCode.toDataURL(JSON.stringify({
    id: reservation.reservationId,
    seats: reservation.seats.map((e: any) => e.seat.id),
  }));

  res.render("success", { title: "Succes", reservation, formattedDate, qrDataUrl });
});

router.post("/reset", checkCsrf, (req: Request, res: Response) => {
  (req.session as any).selectedMovie = null;
  (req.session as any).selectedSeats = [];
  (req.session as any).reservation = null;
  res.redirect("/movies");
});

// ==================
// ADMIN ROUTES
// ==================
// Admin login middleware
function ensureAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any).isAdmin) return next();
  return res.redirect("/admin/login");
}

// Login pagina
router.get("/admin/login", (req: Request, res: Response) => {
  res.render("admin/login", { title: "Login", error: null });
});

// Login verwerken
router.post("/admin/login", checkCsrf, async (req: Request, res: Response) => {
  const { username, password } = req.body;
  
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    (req.session as any).isAdmin = true;
    return res.redirect("/admin");
  }
  
  res.render("admin/login", { title: "Login", error: "Ongeldige gebruikersnaam of wachtwoord" });
});

// Logout
router.get("/admin/logout", (req: Request, res: Response) => {
  (req.session as any).isAdmin = false;
  res.redirect("/");
});

router.get("/admin",  ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { rows: vandaag } = await pool.query(`SELECT COUNT(*) as count FROM boekingen WHERE DATE(geboekt_op) = CURRENT_DATE`);
    const { rows: deze_maand } = await pool.query(`SELECT COUNT(*) as count FROM boekingen WHERE DATE_TRUNC('month', geboekt_op) = DATE_TRUNC('month', NOW())`);
    const { rows: jaaromzet } = await pool.query(`SELECT COALESCE(SUM(totaalbedrag), 0) as totaal FROM boekingen WHERE DATE_TRUNC('year', geboekt_op) = DATE_TRUNC('year', NOW())`);
    const { rows: totaal } = await pool.query(`SELECT COUNT(*) as count FROM boekingen`);
    const { rows: maanden } = await pool.query(`
      SELECT TO_CHAR(geboekt_op, 'Month YYYY') as maand,
             COUNT(*) as aantal,
             COALESCE(SUM(totaalbedrag), 0) as omzet
      FROM boekingen
      GROUP BY DATE_TRUNC('month', geboekt_op), TO_CHAR(geboekt_op, 'Month YYYY')
      ORDER BY DATE_TRUNC('month', geboekt_op) DESC
    `);

    res.render("admin/dashboard", {
      title: "Dashboard",
      stats: {
        vandaag: vandaag[0].count,
        deze_maand: deze_maand[0].count,
        jaaromzet: jaaromzet[0].totaal,
        totaal: totaal[0].count,
      },
      maanden,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Dashboard fout: " + err);
  }
});

router.get("/admin/films",  ensureAdmin, async (req: Request, res: Response) => {
  const { rows: films } = await pool.query("SELECT * FROM films ORDER BY id DESC");
  res.render("admin/films", { title: "Films beheren", films });
});

router.post("/admin/films/:id/verwijderen", checkCsrf,  ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM films WHERE id = $1", [req.params.id]);
  res.redirect("/admin/films");
});

router.get("/admin/films/nieuw",  ensureAdmin,async (req: Request, res: Response) => {
  res.render("admin/film-formulier", { title: "Nieuwe film", film: null, actie: "/admin/films/nieuw", titel: null });
});

router.post("/admin/films/nieuw", ensureAdmin, checkCsrf, async (req: Request, res: Response) => {
  const { titel, genre, beschrijving, duur_minuten, poster_url } = req.body;
  await pool.query(
    "INSERT INTO films (titel, genre, beschrijving, duur_minuten, poster_url) VALUES ($1, $2, $3, $4, $5)",
    [titel, genre, beschrijving, duur_minuten, poster_url],
  );
  res.redirect("/admin/films");
});

router.get("/admin/films/:id/bewerken",  ensureAdmin,  async (req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT * FROM films WHERE id = $1", [req.params.id]);
  res.render("admin/film-formulier", { title: "Film bewerken", film: rows[0], actie: `/admin/films/${req.params.id}/bewerken`, titel: rows[0].titel });
});

router.post("/admin/films/:id/bewerken", ensureAdmin, checkCsrf, async (req: Request, res: Response) => {
  const { titel, genre, beschrijving, duur_minuten, poster_url } = req.body;
  await pool.query(
    "UPDATE films SET titel=$1, genre=$2, beschrijving=$3, duur_minuten=$4, poster_url=$5 WHERE id=$6",
    [titel, genre, beschrijving, duur_minuten, poster_url, req.params.id],
  );
  res.redirect("/admin/films");
});

router.get("/admin/vertoningen",  ensureAdmin,   async (req: Request, res: Response) => {
  const { rows: vertoningen } = await pool.query(`
    SELECT v.*, f.titel as film_titel, z.naam as zaal_naam
    FROM vertoningen v
    JOIN films f ON f.id = v.film_id
    JOIN zalen z ON z.id = v.zaal_id
    ORDER BY v.start_tijd DESC
  `);
  res.render("admin/vertoningen", { title: "Vertoningen", vertoningen });
});

router.get("/admin/vertoningen/nieuw",  ensureAdmin, async (req: Request, res: Response) => {
  const { rows: films } = await pool.query("SELECT * FROM films ORDER BY titel");
  const { rows: zalen } = await pool.query("SELECT * FROM zalen ORDER BY naam");
  res.render("admin/vertoningen-formulier", { title: "Nieuwe vertoning", films, zalen });
});

router.post("/admin/vertoningen/nieuw", checkCsrf, async (req: Request, res: Response) => {
  const { film_id, zaal_id, start_tijd, prijs } = req.body;
  await pool.query(
    "INSERT INTO vertoningen (film_id, zaal_id, start_tijd, prijs) VALUES ($1, $2, $3, $4)",
    [film_id, zaal_id, start_tijd, prijs],
  );
  res.redirect("/admin/vertoningen");
});

router.post("/admin/vertoningen/:id/verwijderen", checkCsrf,  ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM vertoningen WHERE id = $1", [req.params.id]);
  res.redirect("/admin/vertoningen");
});

router.get("/admin/zalen",  ensureAdmin,   async (req: Request, res: Response) => {
  const { rows: zalen } = await pool.query("SELECT * FROM zalen ORDER BY naam");
  res.render("admin/zalen", { title: "Zalen beheren", zalen });
});

router.get("/admin/zalen/nieuw",  ensureAdmin, async(req: Request, res: Response) => {
  res.render("admin/zaal-formulier", { title: "Nieuwe zaal", zaal: null, actie: "/admin/zalen/nieuw" });
});

router.post("/admin/zalen/nieuw", checkCsrf,  ensureAdmin,async (req: Request, res: Response) => {
  const { naam, rijen, stoelen_per_rij } = req.body;
  await pool.query("INSERT INTO zalen (naam, rijen, stoelen_per_rij) VALUES ($1, $2, $3)", [naam, rijen, stoelen_per_rij]);
  res.redirect("/admin/zalen");
});

router.get("/admin/zalen/:id/bewerken",  ensureAdmin,  async (req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT * FROM zalen WHERE id = $1", [req.params.id]);
  res.render("admin/zaal-formulier", { title: "Zaal bewerken", zaal: rows[0], actie: `/admin/zalen/${req.params.id}/bewerken` });
});

router.post("/admin/zalen/:id/bewerken", checkCsrf, async (req: Request, res: Response) => {
  const { naam, rijen, stoelen_per_rij } = req.body;
  await pool.query("UPDATE zalen SET naam=$1, rijen=$2, stoelen_per_rij=$3 WHERE id=$4", [naam, rijen, stoelen_per_rij, req.params.id]);
  res.redirect("/admin/zalen");
});

router.post("/admin/zalen/:id/verwijderen", checkCsrf,  ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM zalen WHERE id = $1", [req.params.id]);
  res.redirect("/admin/zalen");
});

router.get("/admin/boekingen",  ensureAdmin, async (req: Request, res: Response) => {
  const { rows: boekingen } = await pool.query(`
    SELECT b.*, k.naam as klant_naam, f.titel as film_titel
    FROM boekingen b
    JOIN klanten k ON k.id = b.klant_id
    JOIN vertoningen v ON v.id = b.vertoning_id
    JOIN films f ON f.id = v.film_id
    ORDER BY b.geboekt_op DESC
  `);
  res.render("admin/boekingen", { title: "Boekingen", boekingen });
});

router.get("/admin/boekingen/:id",  ensureAdmin, async (req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT b.*, k.naam as klant_naam, k.email as klant_email,
           f.titel as film_titel, z.naam as zaal_naam, v.start_tijd, v.prijs
    FROM boekingen b
    JOIN klanten k ON k.id = b.klant_id
    JOIN vertoningen v ON v.id = b.vertoning_id
    JOIN films f ON f.id = v.film_id
    JOIN zalen z ON z.id = v.zaal_id
    WHERE b.id = $1
  `, [req.params.id]);

  const { rows: stoelen } = await pool.query(
    "SELECT * FROM gereserveerde_stoelen WHERE boeking_id = $1 ORDER BY rij, stoel",
    [req.params.id],
  );

  res.render("admin/boeking-detail", { title: "Boeking detail", boeking: rows[0], stoelen });
});

// ==================
// API ROUTES (geen CSRF - voor externe clients)
// ==================

router.get("/api/locaties", async (req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT * FROM zalen ORDER BY naam");
  res.json(rows);
});

router.get("/api/events", async (req: Request, res: Response) => {
  const { zaal_id } = req.query;
  let query = `
    SELECT v.*, f.titel as film_titel, f.genre, f.beschrijving, z.naam as zaal_naam
    FROM vertoningen v
    JOIN films f ON f.id = v.film_id
    JOIN zalen z ON z.id = v.zaal_id
    WHERE v.start_tijd > NOW()
  `;
  const params: any[] = [];
  if (zaal_id) {
    params.push(zaal_id);
    query += ` AND v.zaal_id = $1`;
  }
  query += " ORDER BY v.start_tijd ASC";
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

router.post("/api/book", async (req: Request, res: Response) => {
  const { vertoning_id, klant, stoelen } = req.body;

  if (!vertoning_id || !klant?.naam || !klant?.email || !stoelen?.length) {
    return res.status(400).json({ error: "Verplichte velden ontbreken" });
  }

  const { rows: klanten } = await pool.query(
    `INSERT INTO klanten (naam, email) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET naam = EXCLUDED.naam
     RETURNING id`,
    [klant.naam, klant.email],
  );

  const { rows: vertoning } = await pool.query(
    "SELECT prijs FROM vertoningen WHERE id = $1",
    [vertoning_id],
  );
  const totaalbedrag = vertoning[0].prijs * stoelen.length;

  const { rows: boeking } = await pool.query(
    `INSERT INTO boekingen (vertoning_id, klant_id, totaalbedrag) VALUES ($1, $2, $3) RETURNING id`,
    [vertoning_id, klanten[0].id, totaalbedrag],
  );

  for (const stoel of stoelen) {
    await pool.query(
      `INSERT INTO gereserveerde_stoelen (boeking_id, rij, stoel) VALUES ($1, $2, $3)`,
      [boeking[0].id, stoel.rij, stoel.stoel],
    );
  }

  res.status(201).json({ success: true, boeking_id: boeking[0].id, totaalbedrag });
});


router.get("/admin/klanten", ensureAdmin, async (req: Request, res: Response) => {
  const { rows: klanten } = await pool.query(`
    SELECT k.*, COUNT(b.id) as aantal_boekingen
    FROM klanten k
    LEFT JOIN boekingen b ON b.klant_id = k.id
    GROUP BY k.id
    ORDER BY k.id DESC
  `);
  res.render("admin/klanten", { title: "Klanten", klanten });
});
export default router;