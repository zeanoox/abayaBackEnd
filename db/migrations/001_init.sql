-- LORIM shop schema (PostgreSQL 15+).
-- Money is stored in integer cents. Translatable text is JSONB: {"nl": "...", "en": "...", "ar": "..."}.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Users (login/registration arrives in a later phase) ----------
CREATE TYPE user_role AS ENUM ('CUSTOMER', 'STAFF', 'ADMIN');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text,
  first_name     text,
  last_name      text,
  phone          text,
  role           user_role NOT NULL DEFAULT 'CUSTOMER',
  email_verified timestamptz,
  active         boolean NOT NULL DEFAULT true,
  locale         text NOT NULL DEFAULT 'nl',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  phone       text,
  line1       text NOT NULL,
  line2       text,
  city        text NOT NULL,
  postal_code text NOT NULL,
  country     char(2) NOT NULL,
  is_default  boolean NOT NULL DEFAULT false
);
CREATE INDEX addresses_user_idx ON addresses (user_id);

-- ---------- Catalogue ----------
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        jsonb NOT NULL,
  description jsonb,
  image       text,
  position    int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  parent_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_active_pos_idx ON categories (active, position);

CREATE TYPE product_status AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  sku          text NOT NULL UNIQUE,
  name         jsonb NOT NULL,
  description  jsonb NOT NULL,
  fabric       jsonb,
  care         jsonb,
  fit          jsonb,
  length_info  jsonb,
  price        int NOT NULL CHECK (price >= 0),
  sale_price   int CHECK (sale_price IS NULL OR (sale_price >= 0 AND sale_price < price)),
  status       product_status NOT NULL DEFAULT 'DRAFT',
  is_featured  boolean NOT NULL DEFAULT false,
  sales_count  int NOT NULL DEFAULT 0,
  search_text  text NOT NULL DEFAULT '', -- lower-cased names + SKUs in every language
  tags         text[] NOT NULL DEFAULT '{}',
  seo_title    jsonb,
  seo_desc     jsonb,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_status_pub_idx ON products (status, published_at DESC);
CREATE INDEX products_status_sales_idx ON products (status, sales_count DESC);

CREATE TABLE product_categories (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_cat_idx ON product_categories (category_id);

CREATE TABLE colors (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code     text NOT NULL UNIQUE,
  name     jsonb NOT NULL,
  hex      text NOT NULL,
  position int NOT NULL DEFAULT 0
);

CREATE TABLE sizes (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code     text NOT NULL UNIQUE, -- S, M, L, XL, XXL, OS (one size)
  position int NOT NULL DEFAULT 0
);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_id   uuid REFERENCES colors(id) ON DELETE SET NULL, -- image shows this colour, if set
  url        text NOT NULL,
  alt        jsonb,
  position   int NOT NULL DEFAULT 0,
  width      int,
  height     int
);
CREATE INDEX product_images_product_idx ON product_images (product_id, position);

CREATE TABLE product_variants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku            text NOT NULL UNIQUE,
  size_id        uuid REFERENCES sizes(id),
  color_id       uuid REFERENCES colors(id),
  length_inch    int CHECK (length_inch IS NULL OR length_inch BETWEEN 40 AND 70),
  price_override int CHECK (price_override IS NULL OR price_override >= 0),
  stock          int NOT NULL DEFAULT 0 CHECK (stock >= 0), -- sellable units (reserved units already removed)
  low_stock_at   int NOT NULL DEFAULT 3,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (product_id, size_id, color_id, length_inch)
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

-- Every stock change is recorded (reservation, release, manual adjustment, return).
CREATE TABLE stock_adjustments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta      int NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('INITIAL', 'RESERVE_ORDER', 'RELEASE_ORDER', 'MANUAL', 'RETURN')),
  order_id   uuid,
  note       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_adjustments_variant_idx ON stock_adjustments (variant_id, created_at DESC);

-- ---------- Cart ----------
CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL UNIQUE, -- random secret kept in the browser
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  coupon_code text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carts_updated_idx ON carts (updated_at);

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   int NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

-- ---------- Shipping & discounts ----------
CREATE TABLE shipping_methods (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text NOT NULL UNIQUE,
  name      jsonb NOT NULL,
  carrier   text,
  price     int NOT NULL CHECK (price >= 0),
  free_over int, -- free at or above this subtotal (cents)
  min_days  int NOT NULL,
  max_days  int NOT NULL,
  countries text[] NOT NULL DEFAULT '{}', -- empty = every country
  active    boolean NOT NULL DEFAULT true,
  position  int NOT NULL DEFAULT 0
);

CREATE TYPE coupon_type AS ENUM ('PERCENT', 'FIXED', 'FREE_SHIPPING');

CREATE TABLE coupons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE, -- stored upper-case
  type         coupon_type NOT NULL,
  value        int NOT NULL DEFAULT 0 CHECK (value >= 0), -- percent or cents
  min_subtotal int,
  starts_at    timestamptz,
  expires_at   timestamptz,
  usage_limit  int,
  used_count   int NOT NULL DEFAULT 0,
  product_ids  uuid[] NOT NULL DEFAULT '{}', -- empty = all products
  category_ids uuid[] NOT NULL DEFAULT '{}', -- empty = all categories
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'PERCENT' OR value <= 100)
);

-- ---------- Orders & payments ----------
CREATE TYPE order_status AS ENUM (
  'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURN_REQUESTED'
);

CREATE SEQUENCE order_number_seq START 10001;

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('LR-' || nextval('order_number_seq')),
  access_token       text NOT NULL UNIQUE, -- lets guests open their own order
  status             order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  locale             text NOT NULL DEFAULT 'nl',
  email              text NOT NULL,
  full_name          text NOT NULL,
  phone              text NOT NULL,
  ship_line1         text NOT NULL,
  ship_line2         text,
  ship_city          text NOT NULL,
  ship_postal_code   text NOT NULL,
  ship_country       char(2) NOT NULL,
  shipping_method_id uuid REFERENCES shipping_methods(id) ON DELETE SET NULL,
  shipping_name      text NOT NULL,
  subtotal           int NOT NULL,
  discount           int NOT NULL DEFAULT 0,
  shipping_cost      int NOT NULL,
  total              int NOT NULL CHECK (total >= 0),
  currency           char(3) NOT NULL DEFAULT 'EUR',
  coupon_code        text,
  stock_reserved     boolean NOT NULL DEFAULT true,
  internal_notes     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  cancelled_at       timestamptz
);
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX orders_email_idx ON orders (lower(email));

-- Snapshot of what was bought; kept even if the product changes later.
CREATE TABLE order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id    uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name  jsonb NOT NULL,
  sku           text NOT NULL,
  variant_label text NOT NULL,
  image_url     text,
  unit_price    int NOT NULL,
  quantity      int NOT NULL CHECK (quantity > 0),
  line_total    int NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       text NOT NULL, -- STATUS | PAYMENT | NOTE
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE TYPE payment_status AS ENUM ('OPEN', 'PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED');

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider     text NOT NULL, -- mollie | mock
  provider_ref text NOT NULL UNIQUE, -- e.g. tr_xxx
  status       payment_status NOT NULL DEFAULT 'OPEN',
  method       text,
  amount       int NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'EUR',
  checkout_url text,
  refunded     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier         text NOT NULL,
  tracking_number text,
  tracking_url    text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipments_order_idx ON shipments (order_id);

CREATE TABLE newsletter_subscribers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  locale     text NOT NULL DEFAULT 'nl',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX newsletter_email_key ON newsletter_subscribers (lower(email));

-- A cart remembers its unpaid order so a second checkout releases the first one instead of reserving stock twice.
ALTER TABLE carts ADD COLUMN pending_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
