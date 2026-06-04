import { Request, Response, NextFunction } from "express";

export function checkCsrf(req: Request, res: Response, next: NextFunction) {
  if (!req.body) return next();
  const token = req.body._csrf;
  if (!token || token !== (req.session as any).csrfToken) {
    return res.status(403).send("Ongeldige CSRF token");
  }
  next();
}

export function getSelectedMovie(req: Request) {
  return (req.session as any).selectedMovie || null;
}

export function getSelectedSeats(req: Request) {
  return (req.session as any).selectedSeats || [];
}

export function ensureMovie(req: Request, res: Response, next: NextFunction) {
  if (!getSelectedMovie(req)) return res.redirect("/movies");
  return next();
}

export function ensureSeats(req: Request, res: Response, next: NextFunction) {
  if (!getSelectedMovie(req) || getSelectedSeats(req).length === 0) {
    return res.redirect("/seats");
  }
  return next();
}

export function ensureReservation(req: Request, res: Response, next: NextFunction) {
  if (!(req.session as any).reservation) return res.redirect("/confirm");
  return next();
}

export function ensureAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any).isAdmin) return next();
  return res.redirect("/admin/login");
}