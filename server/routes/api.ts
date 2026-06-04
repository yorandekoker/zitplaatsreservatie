import express, { Request, Response } from "express";
import pool from "../db/db";

const router = express.Router();

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

export default router;