-- MiniMax Local company environment guard template.
-- Replace <COMPANY_ID> before applying.
-- Do not commit API key material.

CREATE OR REPLACE FUNCTION public.paperclip_minimax_company_env_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $FN$
DECLARE
  target_company uuid := '<COMPANY_ID>'::uuid;
  model_name text;
  safe_cwd text;
  env_json jsonb;
BEGIN
  IF NEW.company_id IS DISTINCT FROM target_company THEN
    RETURN NEW;
  END IF;

  IF NEW.adapter_type IS DISTINCT FROM 'minimax_local' THEN
    RETURN NEW;
  END IF;

  model_name := COALESCE(NULLIF(NEW.adapter_config->>'model', ''), 'MiniMax-M3');

  IF model_name !~ '^MiniMax-' THEN
    model_name := 'MiniMax-M3';
  END IF;

  safe_cwd := '/paperclip/instances/default/workspaces/' || NEW.id::text;

  env_json :=
    COALESCE(NEW.adapter_config->'env', '{}'::jsonb)
    - 'MINIMAX_API_KEY'
    - 'MINIMAX_API_KEY_FILE';

  NEW.adapter_config :=
    COALESCE(NEW.adapter_config, '{}'::jsonb)
    || jsonb_build_object(
      'model', model_name,
      'primaryModel', model_name,
      'baseUrl', COALESCE(NULLIF(NEW.adapter_config->>'baseUrl', ''), 'https://api.minimax.io/v1'),
      'temperature', COALESCE(NEW.adapter_config->'temperature', '0.2'::jsonb),
      'maxTokens', COALESCE(NEW.adapter_config->'maxTokens', '2048'::jsonb),
      'max_completion_tokens', COALESCE(NEW.adapter_config->'max_completion_tokens', '2048'::jsonb),
      'stripThink', COALESCE(NEW.adapter_config->'stripThink', 'true'::jsonb),
      'freshSession', true,
      'resume', false,
      'resumeSession', false,
      'cwd', COALESCE(NULLIF(NEW.adapter_config->>'cwd', ''), safe_cwd),
      'workingDirectory', COALESCE(NULLIF(NEW.adapter_config->>'workingDirectory', ''), safe_cwd),
      'env', env_json
    );

  RETURN NEW;
END
$FN$;

DROP TRIGGER IF EXISTS paperclip_minimax_company_env_guard_tg ON agents;

CREATE TRIGGER paperclip_minimax_company_env_guard_tg
BEFORE INSERT OR UPDATE OF adapter_type, adapter_config
ON agents
FOR EACH ROW
EXECUTE FUNCTION public.paperclip_minimax_company_env_guard();

CREATE OR REPLACE FUNCTION public.paperclip_block_minimax_company_secret_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $FN$
DECLARE
  target_company uuid := '<COMPANY_ID>'::uuid;
BEGIN
  IF NEW.company_id = target_company
     AND NEW.config_path = 'env.MINIMAX_API_KEY' THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END
$FN$;

DROP TRIGGER IF EXISTS paperclip_block_minimax_company_secret_ref_tg ON company_secret_bindings;

CREATE TRIGGER paperclip_block_minimax_company_secret_ref_tg
BEFORE INSERT OR UPDATE
ON company_secret_bindings
FOR EACH ROW
EXECUTE FUNCTION public.paperclip_block_minimax_company_secret_ref();
