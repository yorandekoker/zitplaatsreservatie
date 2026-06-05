import express, { Request, Response } from "express";
import pool from "../db/db";
import bcrypt from "bcrypt";
import QRCode from "qrcode";
import {
  checkCsrf,
  ensureMovie,
  ensureReservation,
  ensureSeats,
  getSelectedMovie,
  getSelectedSeats,
} from "./shared";

const router = express.Router();

router.get("/", (req: Request, res: Response) => {
  res.render("home", { title: "Cinegraaf" });
});

router.get("/login", (req: Request, res: Response) => {
  res.render("login", { title: "Inloggen", error: null });
});

router.post("/login", checkCsrf, async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (
    email === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    (req.session as any).isAdmin = true;
    return res.redirect("/admin");
  }

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

router.get("/registreer", (req: Request, res: Response) => {
  res.render("registreer", { title: "Registreren", error: null });
});

router.post("/registreer", checkCsrf, async (req: Request, res: Response) => {
  const { naam, email, password } = req.body;

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

router.get("/logout", (req: Request, res: Response) => {
  (req.session as any).klant = null;
  res.redirect("/");
});

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
    weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Brussels",
  }).format(new Date(movie.start_tijd));

  res.render("confirm", { title: "Bevestig", movie, selectedSeats, total, formattedDate });
});

router.post("/confirm", checkCsrf, ensureSeats, async (req: Request, res: Response) => {
  const movie = getSelectedMovie(req);
  const selectedSeats = getSelectedSeats(req);
  const totalPrice = selectedSeats.reduce((sum: number, e: any) => sum + e.seat.price, 0);

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
    weekday: "short", day: "numeric", month: "short", year: "numeric",  hour: "2-digit",
  minute: "2-digit",
    timeZone: "Europe/Brussels",
  }).format(new Date(reservation.movie.start_tijd));

  res.render("payment", { title: "Betaling", reservation, formattedDate });
});

router.get("/success", ensureReservation, async (req: Request, res: Response) => {
  const reservation = (req.session as any).reservation;
  const formattedDate = new Intl.DateTimeFormat("nl-BE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",  hour: "2-digit",
  minute: "2-digit",
    timeZone: "Europe/Brussels",
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

export default router;