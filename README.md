# VoltKart (Python edition) – electronics ecommerce store

Flask + SQLite backend, vanilla JS frontend (no build step).

## Run it

Requires Python 3.9+.

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:3000. The database (`voltkart.db`) is created and seeded from `products.json` on first run.

Optional env vars: `PORT` (default 3000), `JWT_SECRET` (otherwise a random one is saved to `.jwt-secret`), `DB_PATH`.

## Features

- Search, category chips, brand filter, sorting (popularity, price, rating, discount)
- Product detail with specs, stock status, related products
- Sign up / log in (hashed passwords, JWT sessions)
- Per-user cart with stock checks; free delivery above ₹999, otherwise ₹79
- Checkout with address validation; COD / UPI / card options (payments are simulated)
- Stock is deducted inside a locked database transaction, so orders can't oversell
- Order history

## Files

- `app.py` – all backend routes
- `products.json` – seed catalogue (edit, then delete `voltkart.db` to re-seed)
- `public/` – frontend (`style.css` has the colour/font variables at the top)

## Going live

Don't use the dev server in production. Use e.g. `pip install gunicorn && gunicorn -w 2 -b 0.0.0.0:3000 app:app`,
serve over HTTPS, set a strong `JWT_SECRET`, add rate limiting on login, and integrate a real payment gateway (e.g. Razorpay) in `place_order`.
