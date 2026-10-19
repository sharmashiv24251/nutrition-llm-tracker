-- Carbs and fat targets become optional: I track a calorie ceiling plus protein and fibre floors.
-- Touches only trk_targets.

alter table trk_targets alter column carbs_g drop not null;
alter table trk_targets alter column fat_g drop not null;

comment on column trk_targets.kcal is 'Ceiling';
comment on column trk_targets.protein_g is 'Floor (eat at least this)';
comment on column trk_targets.fibre_g is 'Floor (eat at least this)';
comment on column trk_targets.carbs_g is 'Optional; null = no target';
comment on column trk_targets.fat_g is 'Optional; null = no target';

insert into trk_targets (effective_from, kcal, protein_g, carbs_g, fat_g, fibre_g)
values ('2026-10-19', 2200, 120, null, null, 30);
