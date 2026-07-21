-- Test de aislamiento cross-tenant (docs/11 §10). Corre COMO el rol de app
-- (no-dueño), que es el escenario real de runtime. Se siembra como superusuario
-- (RLS lo bypassa) y se prueba como automata_app (RLS aplica). Todo en una
-- transacción que se revierte, así el test es repetible.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  cnt int;
BEGIN
  -- Semilla (como superusuario: RLS bypassed).
  INSERT INTO orgs (id, nombre) VALUES (a, 'Org A'), (b, 'Org B');
  INSERT INTO memberships (org_id, user_id, rol) VALUES (a, 'u_ana', 'admin'), (b, 'u_beto', 'admin');
  INSERT INTO automatizaciones (org_id, nombre) VALUES (a, 'A1'), (a, 'A2'), (b, 'B1');

  -- A partir de aquí, corremos COMO el rol de aplicación: RLS aplica.
  SET LOCAL ROLE automata_app;

  -- Contexto = A: ve solo las 2 de A.
  PERFORM set_config('app.current_org', a::text, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 2 THEN RAISE EXCEPTION 'FALLO: con org A esperaba 2 automatizaciones, vi %', cnt; END IF;
  RAISE NOTICE 'PASS · como app con contexto A: ve sus 2 automatizaciones';

  -- Cross-tenant: aunque pida explícitamente las de B, ve 0.
  SELECT count(*) INTO cnt FROM automatizaciones WHERE org_id = b;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FALLO CROSS-TENANT: vi % filas de la org B', cnt; END IF;
  RAISE NOTICE 'PASS · cross-tenant: 0 filas de B aunque las pida por org_id';

  -- Membership de B tampoco es visible desde A.
  SELECT count(*) INTO cnt FROM memberships;
  IF cnt <> 1 THEN RAISE EXCEPTION 'FALLO: memberships visibles = % (esperaba 1)', cnt; END IF;
  RAISE NOTICE 'PASS · memberships aislados (solo la de A)';

  -- WITH CHECK: no puede INSERTAR en B mientras el contexto es A.
  BEGIN
    INSERT INTO automatizaciones (org_id, nombre) VALUES (b, 'intruso');
    RAISE EXCEPTION 'FALLO: se pudo insertar en la org B con contexto A';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS · WITH CHECK: no se puede escribir en otra org';
  END;

  -- Cambiar de contexto a B: ahora ve solo la de B.
  PERFORM set_config('app.current_org', b::text, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 1 THEN RAISE EXCEPTION 'FALLO: con org B esperaba 1, vi %', cnt; END IF;
  RAISE NOTICE 'PASS · cambio de contexto a B: ve su 1 automatización';

  -- Sin contexto → fail-closed: 0 filas (no un leak).
  PERFORM set_config('app.current_org', NULL, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FALLO FAIL-OPEN: sin contexto vi % filas', cnt; END IF;
  RAISE NOTICE 'PASS · fail-closed: sin org en la sesión no ve nada';

  RESET ROLE;
  RAISE NOTICE '── AISLAMIENTO CROSS-TENANT: 6/6 ✓ ──';
END $$;

ROLLBACK;
