"""VoltKart – electronics store. Flask + SQLite backend serving the static frontend in ./public."""
import json
import os
import re
import secrets
import sqlite3
import datetime as dt
from functools import wraps
from pathlib import Path

import jwt
from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

BASE = Path(__file__).parent
DB_PATH = os.environ.get("DB_PATH", str(BASE / "voltkart.db"))
PORT = int(os.environ.get("PORT", 3000))


def load_secret() -> str:
    if os.environ.get("JWT_SECRET"):
        return os.environ["JWT_SECRET"]
    f = BASE / ".jwt-secret"
    if f.exists():
        return f.read_text().strip()
    s = secrets.token_hex(48)
    f.write_text(s)
    f.chmod(0o600)
    return s


JWT_SECRET = load_secret()
app = Flask(__name__, static_folder=None)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, brand TEXT NOT NULL, category TEXT NOT NULL,
  price INTEGER NOT NULL, mrp INTEGER NOT NULL,
  rating REAL NOT NULL DEFAULT 4.0, reviews INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  emoji TEXT NOT NULL DEFAULT '📦', color TEXT NOT NULL DEFAULT '#6366f1',
  description TEXT NOT NULL, specs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS cart_items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Placed',
  payment_method TEXT NOT NULL,
  ship_name TEXT NOT NULL, ship_phone TEXT NOT NULL, ship_address TEXT NOT NULL,
  ship_city TEXT NOT NULL, ship_pincode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL
);
"""


# ---------- database ----------
def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.execute("PRAGMA journal_mode = WAL")
    if db.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0:
        items = json.loads((BASE / "products.json").read_text(encoding="utf-8"))
        db.executemany(
            """INSERT INTO products (name, brand, category, price, mrp, rating, reviews, stock,
                                     emoji, color, description, specs)
               VALUES (:name, :brand, :category, :price, :mrp, :rating, :reviews, :stock,
                       :emoji, :color, :description, :specs)""",
            [{**p, "specs": json.dumps(p["specs"])} for p in items],
        )
        db.commit()
        print(f"Seeded {len(items)} products")
    db.close()


def product_dict(row) -> dict:
    d = dict(row)
    d["specs"] = json.loads(d["specs"])
    return d


# ---------- errors / auth ----------
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(404)
def handle_404(_e):
    return jsonify(error="Not found"), 404


@app.errorhandler(Exception)
def handle_unexpected(e):
    app.logger.exception(e)
    return jsonify(error="Something went wrong on our side"), 500


def sign_token(user: dict) -> str:
    payload = {**user, "exp": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7)}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise ApiError("Please log in first", 401)
        try:
            g.user = jwt.decode(header[7:], JWT_SECRET, algorithms=["HS256"])
        except jwt.PyJWTError:
            raise ApiError("Session expired, please log in again", 401)
        return fn(*args, **kwargs)

    return wrapper


def body() -> dict:
    return request.get_json(silent=True) or {}


# ---------- auth routes ----------
@app.post("/api/auth/register")
def register():
    b = body()
    name, email, password = (b.get("name") or "").strip(), (b.get("email") or "").strip().lower(), b.get("password") or ""
    if not (name and email and password):
        raise ApiError("Name, email and password are required")
    if not re.match(r"^\S+@\S+\.\S+$", email):
        raise ApiError("Enter a valid email")
    if len(password) < 6:
        raise ApiError("Password must be at least 6 characters")
    db = get_db()
    if db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
        raise ApiError("An account with this email already exists", 409)
    cur = db.execute(
        "INSERT INTO users (name, email, password_hash) VALUES (?,?,?)",
        (name, email, generate_password_hash(password)),
    )
    db.commit()
    user = {"id": cur.lastrowid, "name": name, "email": email}
    return jsonify(token=sign_token(user), user=user), 201


@app.post("/api/auth/login")
def login():
    b = body()
    email, password = (b.get("email") or "").strip().lower(), b.get("password") or ""
    if not (email and password):
        raise ApiError("Email and password are required")
    row = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        raise ApiError("Incorrect email or password", 401)
    user = {"id": row["id"], "name": row["name"], "email": row["email"]}
    return jsonify(token=sign_token(user), user=user)


@app.get("/api/auth/me")
@login_required
def me():
    return jsonify(user={k: g.user[k] for k in ("id", "name", "email")})


# ---------- products ----------
SORTS = {
    "price-asc": "price ASC",
    "price-desc": "price DESC",
    "rating": "rating DESC",
    "discount": "(mrp - price) * 1.0 / mrp DESC",
    "popular": "reviews DESC",
}


@app.get("/api/products")
def list_products():
    a = request.args
    where, params = [], []
    if a.get("q"):
        where.append("(name LIKE ? OR brand LIKE ? OR category LIKE ? OR description LIKE ?)")
        params += [f"%{a['q']}%"] * 4
    if a.get("category") and a["category"] != "All":
        where.append("category = ?"); params.append(a["category"])
    if a.get("brand"):
        where.append("brand = ?"); params.append(a["brand"])
    if a.get("min", type=int) is not None:
        where.append("price >= ?"); params.append(a.get("min", type=int))
    if a.get("max", type=int) is not None:
        where.append("price <= ?"); params.append(a.get("max", type=int))
    order = SORTS.get(a.get("sort"), SORTS["popular"])  # whitelisted, never user text
    sql = f"SELECT * FROM products {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {order}"
    rows = get_db().execute(sql, params).fetchall()
    return jsonify(products=[product_dict(r) for r in rows])


@app.get("/api/products/meta")
def products_meta():
    db = get_db()
    cats = db.execute("SELECT category AS name, COUNT(*) AS count FROM products GROUP BY category ORDER BY count DESC").fetchall()
    brands = [r["brand"] for r in db.execute("SELECT DISTINCT brand FROM products ORDER BY brand")]
    return jsonify(categories=[dict(c) for c in cats], brands=brands)


@app.get("/api/products/<int:pid>")
def get_product(pid):
    db = get_db()
    p = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    if not p:
        raise ApiError("Product not found", 404)
    related = db.execute("SELECT * FROM products WHERE category = ? AND id != ? LIMIT 4", (p["category"], pid)).fetchall()
    return jsonify(product=product_dict(p), related=[product_dict(r) for r in related])


# ---------- cart ----------
def read_cart(user_id: int) -> dict:
    rows = get_db().execute(
        """SELECT c.product_id, c.qty, p.name, p.price, p.mrp, p.emoji, p.color, p.stock, p.brand
           FROM cart_items c JOIN products p ON p.id = c.product_id
           WHERE c.user_id = ? ORDER BY p.name""",
        (user_id,),
    ).fetchall()
    items = [dict(r) for r in rows]
    subtotal = sum(i["price"] * i["qty"] for i in items)
    savings = sum((i["mrp"] - i["price"]) * i["qty"] for i in items)
    shipping = 0 if subtotal == 0 or subtotal >= 999 else 79
    return {"items": items, "subtotal": subtotal, "savings": savings, "shipping": shipping, "total": subtotal + shipping}


@app.get("/api/cart")
@login_required
def get_cart():
    return jsonify(read_cart(g.user["id"]))


@app.post("/api/cart")
@login_required
def add_to_cart():
    b = body()
    try:
        pid = int(b.get("productId"))
        qty = max(1, int(b.get("qty") or 1))
    except (TypeError, ValueError):
        raise ApiError("Invalid product")
    db = get_db()
    p = db.execute("SELECT id, stock FROM products WHERE id = ?", (pid,)).fetchone()
    if not p:
        raise ApiError("Product not found", 404)
    existing = db.execute("SELECT qty FROM cart_items WHERE user_id = ? AND product_id = ?", (g.user["id"], pid)).fetchone()
    new_qty = (existing["qty"] if existing else 0) + qty
    if new_qty > p["stock"]:
        raise ApiError(f"Only {p['stock']} left in stock")
    db.execute(
        """INSERT INTO cart_items (user_id, product_id, qty) VALUES (?,?,?)
           ON CONFLICT(user_id, product_id) DO UPDATE SET qty = excluded.qty""",
        (g.user["id"], pid, new_qty),
    )
    db.commit()
    return jsonify(read_cart(g.user["id"]))


@app.put("/api/cart/<int:pid>")
@login_required
def update_cart(pid):
    qty = body().get("qty")
    if not isinstance(qty, int) or isinstance(qty, bool) or qty < 0:
        raise ApiError("Invalid quantity")
    db = get_db()
    if qty == 0:
        db.execute("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?", (g.user["id"], pid))
    else:
        p = db.execute("SELECT stock FROM products WHERE id = ?", (pid,)).fetchone()
        if not p:
            raise ApiError("Product not found", 404)
        if qty > p["stock"]:
            raise ApiError(f"Only {p['stock']} left in stock")
        db.execute("UPDATE cart_items SET qty = ? WHERE user_id = ? AND product_id = ?", (qty, g.user["id"], pid))
    db.commit()
    return jsonify(read_cart(g.user["id"]))


@app.delete("/api/cart/<int:pid>")
@login_required
def delete_cart_item(pid):
    db = get_db()
    db.execute("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?", (g.user["id"], pid))
    db.commit()
    return jsonify(read_cart(g.user["id"]))


# ---------- orders ----------
@app.post("/api/orders")
@login_required
def place_order():
    b = body()
    fields = {k: str(b.get(k) or "").strip() for k in ("name", "phone", "address", "city", "pincode")}
    if not all(fields.values()):
        raise ApiError("Please fill in all delivery details")
    if not re.fullmatch(r"\d{10}", fields["phone"]):
        raise ApiError("Enter a valid 10-digit phone number")
    if not re.fullmatch(r"\d{6}", fields["pincode"]):
        raise ApiError("Enter a valid 6-digit pincode")
    method = b.get("paymentMethod") if b.get("paymentMethod") in ("COD", "UPI", "CARD") else "COD"

    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")  # lock so two checkouts can't oversell the same stock
        cart = read_cart(g.user["id"])
        if not cart["items"]:
            raise ApiError("Your cart is empty")
        for i in cart["items"]:
            cur = db.execute(
                "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?",
                (i["qty"], i["product_id"], i["qty"]),
            )
            if cur.rowcount == 0:
                raise ApiError(f"\"{i['name']}\" is out of stock or has fewer units than in your cart", 409)
        cur = db.execute(
            """INSERT INTO orders (user_id, total, payment_method, ship_name, ship_phone,
                                   ship_address, ship_city, ship_pincode) VALUES (?,?,?,?,?,?,?,?)""",
            (g.user["id"], cart["total"], method, fields["name"], fields["phone"],
             fields["address"], fields["city"], fields["pincode"]),
        )
        order_id = cur.lastrowid
        db.executemany(
            "INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)",
            [(order_id, i["product_id"], i["name"], i["price"], i["qty"]) for i in cart["items"]],
        )
        db.execute("DELETE FROM cart_items WHERE user_id = ?", (g.user["id"],))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify(orderId=order_id, total=cart["total"]), 201


@app.get("/api/orders")
@login_required
def list_orders():
    db = get_db()
    orders = []
    for o in db.execute("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", (g.user["id"],)):
        d = dict(o)
        d["items"] = [dict(i) for i in db.execute("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))]
        orders.append(d)
    return jsonify(orders=orders)


# ---------- frontend ----------
@app.get("/")
def index():
    return send_from_directory(BASE / "public", "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    if filename.startswith("api/"):
        raise ApiError("Not found", 404)
    return send_from_directory(BASE / "public", filename)


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=os.environ.get("FLASK_DEBUG") == "1")
