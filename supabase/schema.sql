-- Reference copy of the Kitchen schema. Applied to the personal Supabase
-- project dgnxbcoxdpdloplkcmzs as the migration `kitchen_app_schema`.
--
-- That project also holds Ledger (entry_types, logs, reflections, allowed_emails)
-- and Overtime (ot_*). Everything here is prefixed mp_ so the three apps can
-- never collide. Don't touch the other two apps' tables.

create table mp_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  name_el    text check (name_el is null or length(btrim(name_el)) > 0),   -- Greek name; name stays canonical
  aisle      text not null default 'other',
  unit       text,
  created_at timestamptz not null default now()
);
-- The catalogue is a set, case-insensitively: typing "Olive Oil" must find the
-- existing "olive oil" rather than creating a twin that splits the shopping list.
create unique index mp_items_name on mp_items (user_id, lower(btrim(name)));
-- Same for the Greek name (migration kitchen_greek_names).
create unique index mp_items_name_el on mp_items (user_id, lower(btrim(name_el))) where name_el is not null;

create table mp_recipes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null check (length(btrim(title)) > 0),
  servings   int  not null default 2 check (servings between 1 and 99),
  minutes    int  check (minutes is null or minutes > 0),
  video      text,                                  -- YouTube id only, never a full URL
  steps      text[] not null default '{}',
  note       text,
  created_at timestamptz not null default now()
);
create index mp_recipes_user on mp_recipes (user_id, created_at desc);

-- name is denormalised alongside item_id so deleting a catalogue entry can never
-- blank out an ingredient line in a recipe that already used it.
create table mp_recipe_items (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recipe_id uuid not null references mp_recipes(id) on delete cascade,
  item_id   uuid references mp_items(id) on delete set null,
  name      text not null,
  name_el   text,                                   -- denormalised, like name
  qty       numeric check (qty is null or qty >= 0),
  unit      text,
  pos       int not null default 0
);
create index mp_recipe_items_recipe on mp_recipe_items (recipe_id, pos);

-- What you've decided to cook. Keyed by recipe, so adding twice is idempotent.
create table mp_basket (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recipe_id uuid not null references mp_recipes(id) on delete cascade,
  servings  int  not null default 2 check (servings between 1 and 99),
  -- lower(name)s of this recipe's ingredients you already have at home; they
  -- stay off this week's shopping list (migration kitchen_basket_have).
  have      text[] not null default '{}',
  added_at  timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

-- Things you need that no recipe asked for: bin bags, milk, coffee.
create table mp_extras (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  qty        numeric check (qty is null or qty >= 0),
  unit       text,
  aisle      text not null default 'other',
  created_at timestamptz not null default now()
);
create index mp_extras_user on mp_extras (user_id, created_at);

-- Your own shop categories (migration kitchen_aisles). No rows = the built-in
-- walk in index.html's AISLES. The first edit writes the whole list, so from
-- then on this table is the order. key is what mp_items.aisle / mp_extras.aisle
-- hold; name null means "the built-in label, translated".
create table mp_aisles (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null check (length(btrim(key)) > 0),
  name       text check (name is null or length(btrim(name)) > 0),
  pos        int  not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Baskets: named sets of groceries, independent of recipes — "Weekly
-- staples", "BBQ Saturday" (migration kitchen_lists). Called lists here
-- because mp_basket is already taken by the meal plan. active = on this
-- week's shopping list.
create table mp_lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  active     boolean not null default false,
  created_at timestamptz not null default now()
);
create index mp_lists_user on mp_lists (user_id, created_at);

-- Same shape as mp_recipe_items, name denormalised for the same reason.
create table mp_list_items (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  list_id  uuid not null references mp_lists(id) on delete cascade,
  item_id  uuid references mp_items(id) on delete set null,
  name     text not null check (length(btrim(name)) > 0),
  name_el  text,
  qty      numeric check (qty is null or qty >= 0),
  unit     text,
  pos      int not null default 0
);
create index mp_list_items_list on mp_list_items (list_id, pos);

alter table mp_lists        enable row level security;
alter table mp_list_items   enable row level security;
alter table mp_aisles       enable row level security;
alter table mp_items        enable row level security;
alter table mp_recipes      enable row level security;
alter table mp_recipe_items enable row level security;
alter table mp_basket       enable row level security;
alter table mp_extras       enable row level security;

create policy mp_items_own        on mp_items        for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_recipes_own      on mp_recipes      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_recipe_items_own on mp_recipe_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_basket_own       on mp_basket       for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_extras_own       on mp_extras       for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_aisles_own       on mp_aisles       for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_lists_own        on mp_lists        for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mp_list_items_own   on mp_list_items   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
