-- 我的衣橱 · Supabase 初始化脚本
-- 用法：Supabase 控制台 → SQL Editor → New query → 全文粘贴 → 点 Run
-- 说明：只建两张表和行级权限规则，不动你项目里的其它内容。可重复执行。

create table if not exists public.wardrobe_items (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.wardrobe_outfits (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists wardrobe_items_user_idx    on public.wardrobe_items(user_id);
create index if not exists wardrobe_outfits_user_idx  on public.wardrobe_outfits(user_id);

alter table public.wardrobe_items   enable row level security;
alter table public.wardrobe_outfits enable row level security;

drop policy if exists "wardrobe_items_owner" on public.wardrobe_items;
create policy "wardrobe_items_owner" on public.wardrobe_items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "wardrobe_outfits_owner" on public.wardrobe_outfits;
create policy "wardrobe_outfits_owner" on public.wardrobe_outfits
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
