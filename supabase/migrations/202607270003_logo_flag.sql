-- EstratégiaPro CRM — registro de identidade visual do cliente
-- Saber que um cliente NÃO tem logo é informação de trabalho para a agência,
-- não só um detalhe de interface. Por isso vira campo, e não apenas ausência
-- de arquivo.
-- null  = ainda não perguntamos
-- true  = tem logo (arquivo em logo_path)
-- false = não tem, precisa criar

alter table public.brand_kits
  add column if not exists has_logo boolean;

comment on column public.brand_kits.has_logo is
  'Se o cliente possui logomarca. false indica que criar a identidade visual é uma entrega da agência.';

notify pgrst, 'reload schema';
