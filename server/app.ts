import dotenv from "dotenv";
dotenv.config();

import express, { Application, Request, Response, NextFunction } from "express";
import path from "path";
import session from "express-session";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import routes from "./routes";
import connectPgSimple from "connect-pg-simple";

const PgSession = connectPgSimple(session);
const app: Application = express();
app.set("trust proxy", 1);
const PORT: number = 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));


app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(cookieParser());

app.use(session({
  store: new PgSession({
    conString: process.env.DATABASE_URL,
    tableName: "sessies",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || "cinegraaf-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000 // 24 uur
  }
}));


// Eigen CSRF implementatie
// CSRF - sla /api routes over
app.use((req: Request, res: Response, next: NextFunction) => {
  res.locals.currentPath = req.path;
  res.locals.klant = (req.session as any).klant || null;

  if ((req.session as any).csrfToken) {
    res.locals.csrfToken = (req.session as any).csrfToken;
    return next();
  }

  (req.session as any).csrfToken = crypto.randomBytes(32).toString("hex");
  req.session.save((err) => {
    if (err) console.error("Sessie opslaan mislukt:", err);
    res.locals.csrfToken = (req.session as any).csrfToken;
    next();
  });
});

app.use("/", routes);

app.listen(PORT, (): void => {
  console.log(`Server draait op http://localhost:${PORT}`);
});
