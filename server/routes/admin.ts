import express, { Request, Response } from "express";
import pool from "../db/db";
import { checkCsrf, ensureAdmin } from "./shared";

const router = express.Router();

router.get("/admin/login", (req: Request, res: Response) => {
  res.render("admin/login", { title: "Login", error: null });
});

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

router.get("/admin/logout", (req: Request, res: Response) => {
  (req.session as any).isAdmin = false;
  res.redirect("/");
});

router.get("/admin", ensureAdmin, async (req: Request, res: Response) => {
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

router.get("/admin/films", ensureAdmin, async (req: Request, res: Response) => {
  const { rows: films } = await pool.query("SELECT * FROM films ORDER BY id DESC");
  res.render("admin/films", { title: "Films beheren", films });
});

router.post("/admin/films/:id/verwijderen", checkCsrf, ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM films WHERE id = $1", [req.params.id]);
  res.redirect("/admin/films");
});

router.get("/admin/films/nieuw", ensureAdmin, async (req: Request, res: Response) => {
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

router.get("/admin/films/:id/bewerken", ensureAdmin, async (req: Request, res: Response) => {
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

router.get("/admin/vertoningen", ensureAdmin, async (req: Request, res: Response) => {
  const { rows: vertoningen } = await pool.query(`
    SELECT v.*, f.titel as film_titel, z.naam as zaal_naam
    FROM vertoningen v
    JOIN films f ON f.id = v.film_id
    JOIN zalen z ON z.id = v.zaal_id
    ORDER BY v.start_tijd DESC
  `);
  res.render("admin/vertoningen", { title: "Vertoningen", vertoningen });
});

router.get("/admin/vertoningen/nieuw", ensureAdmin, async (req: Request, res: Response) => {
  const { rows: films } = await pool.query("SELECT * FROM films ORDER BY titel");
  const { rows: zalen } = await pool.query("SELECT * FROM zalen ORDER BY naam");
  res.render("admin/vertoningen-formulier", { title: "Nieuwe vertoning", films, zalen });
});

router.post("/admin/vertoningen/nieuw", ensureAdmin, checkCsrf, async (req: Request, res: Response) => {
  const { film_id, zaal_id, start_tijd, prijs } = req.body;

  try {
    // Haal duur van de film op
    const { rows: filmRows } = await pool.query(
      "SELECT duur_minuten FROM films WHERE id = $1",
      [film_id]
    );
    const duur = filmRows[0].duur_minuten || 120;

    // Check overlap: kijk of er al een vertoning is in deze zaal die overlapt
    const { rows: overlap } = await pool.query(`
      SELECT v.id, f.titel, v.start_tijd, f.duur_minuten
      FROM vertoningen v
      JOIN films f ON f.id = v.film_id
      WHERE v.zaal_id = $1
      AND (
        -- Nieuwe vertoning start tijdens bestaande vertoning
        ($2 >= v.start_tijd AND $2 < v.start_tijd + (f.duur_minuten || ' minutes')::interval)
        OR
        -- Bestaande vertoning start tijdens nieuwe vertoning
        (v.start_tijd >= $2 AND v.start_tijd < $2::timestamptz + ($3 || ' minutes')::interval)
      )
    `, [zaal_id, start_tijd, duur]);

    if (overlap.length > 0) {
      const { rows: films } = await pool.query("SELECT * FROM films ORDER BY titel");
      const { rows: zalen } = await pool.query("SELECT * FROM zalen ORDER BY naam");
      return res.render("admin/vertoningen-formulier", {
        title: "Nieuwe vertoning",
        films,
        zalen,
        error: `⚠️ Overlap met "${overlap[0].titel}" die speelt om ${new Date(overlap[0].start_tijd).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels' })}`
      });
    }

    await pool.query(
      "INSERT INTO vertoningen (film_id, zaal_id, start_tijd, prijs) VALUES ($1, $2, $3, $4)",
      [film_id, zaal_id, start_tijd, prijs],
    );
    res.redirect("/admin/vertoningen");

  } catch (err: any) {
    console.error("Fout bij vertoning aanmaken:", err);
    res.status(500).send("Fout: " + err.message);
  }
});

router.post("/admin/vertoningen/:id/verwijderen", checkCsrf, ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM vertoningen WHERE id = $1", [req.params.id]);
  res.redirect("/admin/vertoningen");
});

router.get("/admin/zalen", ensureAdmin, async (req: Request, res: Response) => {
  const { rows: zalen } = await pool.query("SELECT * FROM zalen ORDER BY naam");
  res.render("admin/zalen", { title: "Zalen beheren", zalen });
});

router.get("/admin/zalen/nieuw", ensureAdmin, async (req: Request, res: Response) => {
  res.render("admin/zaal-formulier", { title: "Nieuwe zaal", zaal: null, actie: "/admin/zalen/nieuw" });
});

router.post("/admin/zalen/nieuw", checkCsrf, ensureAdmin, async (req: Request, res: Response) => {
  const { naam, rijen, stoelen_per_rij } = req.body;
  await pool.query("INSERT INTO zalen (naam, rijen, stoelen_per_rij) VALUES ($1, $2, $3)", [naam, rijen, stoelen_per_rij]);
  res.redirect("/admin/zalen");
});

router.get("/admin/zalen/:id/bewerken", ensureAdmin, async (req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT * FROM zalen WHERE id = $1", [req.params.id]);
  res.render("admin/zaal-formulier", { title: "Zaal bewerken", zaal: rows[0], actie: `/admin/zalen/${req.params.id}/bewerken` });
});

router.post("/admin/zalen/:id/bewerken", checkCsrf, async (req: Request, res: Response) => {
  const { naam, rijen, stoelen_per_rij } = req.body;
  await pool.query("UPDATE zalen SET naam=$1, rijen=$2, stoelen_per_rij=$3 WHERE id=$4", [naam, rijen, stoelen_per_rij, req.params.id]);
  res.redirect("/admin/zalen");
});

router.post("/admin/zalen/:id/verwijderen", checkCsrf, ensureAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM zalen WHERE id = $1", [req.params.id]);
  res.redirect("/admin/zalen");
});

router.get("/admin/boekingen", ensureAdmin, async (req: Request, res: Response) => {
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

router.get("/admin/boekingen/:id", ensureAdmin, async (req: Request, res: Response) => {
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