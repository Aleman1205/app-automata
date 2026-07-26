-- Test de aislamiento cross-tenant (docs/11 §10). Corre COMO el rol de app
-- (no-dueño), que es el escenario real de runtime. Se siembra como superusuario
-- (RLS lo bypassa) y se prueba como automata_app (RLS aplica). Todo en una
-- transacción que se revierte, así el test es repetible.
--
-- Cubre lectura, INSERT (WITH CHECK), UPDATE/DELETE cross-org, re-etiquetado de
-- org_id, fail-closed, y el ataque de enlace por FK compuesta (versión de A que
-- intenta colgarse de una automatización de B).
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  a  uuid := '11111111-1111-1111-1111-111111111111';
  b  uuid := '22222222-2222-2222-2222-222222222222';
  a1 uuid := 'a0000000-0000-0000-0000-000000000001';
  a2 uuid := 'a0000000-0000-0000-0000-000000000002';
  b1 uuid := 'b0000000-0000-0000-0000-000000000001';
  cnt int;
BEGIN
  -- Semilla (como superusuario: RLS bypassed).
  INSERT INTO orgs (id, nombre) VALUES (a, 'Org A'), (b, 'Org B');
  -- Toda org real tiene subscription: crear una versión (= arrancar un build) ahora
  -- cobra una generación (trigger cobrar_build) y exige la suscripción activa.
  INSERT INTO subscriptions (org_id, plan) VALUES (a, 'equipo'), (b, 'equipo');
  INSERT INTO memberships (org_id, user_id, rol) VALUES (a, 'u_ana', 'admin'), (b, 'u_beto', 'admin');
  INSERT INTO automatizaciones (id, org_id, nombre) VALUES (a1, a, 'A1'), (a2, a, 'A2'), (b1, b, 'B1');

  -- A partir de aquí, corremos COMO el rol de aplicación: RLS aplica.
  SET LOCAL ROLE automata_app;

  -- Contexto = A: ve solo las 2 de A.
  PERFORM set_config('app.current_org', a::text, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 2 THEN RAISE EXCEPTION 'FALLO: con org A esperaba 2 automatizaciones, vi %', cnt; END IF;
  RAISE NOTICE 'PASS · como app con contexto A: ve sus 2 automatizaciones';

  -- Cross-tenant lectura: aunque pida explícitamente las de B, ve 0.
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

  -- UPDATE cross-org: intenta renombrar la de B → 0 filas (invisible, no afecta).
  UPDATE automatizaciones SET nombre = 'secuestrada' WHERE org_id = b;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FALLO: UPDATE cross-org afectó % filas de B', cnt; END IF;
  RAISE NOTICE 'PASS · UPDATE cross-org: 0 filas afectadas';

  -- DELETE: el rol de app ya NO puede borrar automatizaciones (REVOKE, anti-"reciclador"
  -- de docs/06 §3: borrar y recrear reseteaba contador de ajustes y ventana gratis).
  -- Garantía MÁS FUERTE que la de RLS: no es "0 filas", es que no puede borrar nada.
  BEGIN
    DELETE FROM automatizaciones WHERE org_id = b;
    RAISE EXCEPTION 'FALLO: el rol de app pudo ejecutar DELETE (debía estar revocado)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS · DELETE revocado para el rol de app (42501), ni propio ni cross-org';
  END;

  -- a1 (auditoría): el rol de app tampoco BORRA ni CREA una org. RLS se lo dejaría (policy
  -- orgs id=app_current_org()) y el ON DELETE CASCADE arrasaría el ledger "inmutable".
  BEGIN
    DELETE FROM orgs WHERE id = a;
    RAISE EXCEPTION 'FALLO: el rol de app pudo BORRAR su propia org (cascade al ledger)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS · DELETE ON orgs revocado (42501): el tenant no se auto-borra';
  END;

  BEGIN
    INSERT INTO orgs (nombre) VALUES ('intrusa');
    RAISE EXCEPTION 'FALLO: el rol de app pudo CREAR una org';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS · INSERT ON orgs revocado (42501): el app no crea tenants';
  END;

  -- Re-etiquetado: no puede mover una fila PROPIA (A) a la org B (WITH CHECK).
  BEGIN
    UPDATE automatizaciones SET org_id = b WHERE id = a1;
    RAISE EXCEPTION 'FALLO: pudo reasignar org_id de A a B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS · re-etiquetado bloqueado: no puede mover su fila a otra org';
  END;

  -- Ataque de enlace por FK: crear una versión org_id=A que apunte a la
  -- automatización de B (id conocido/adivinado). La FK COMPUESTA lo rechaza porque
  -- (b1, A) no existe como par (id, org_id) en automatizaciones.
  BEGIN
    INSERT INTO versiones (automatizacion_id, org_id, numero, estado)
      VALUES (b1, a, 1, 'lista');
    RAISE EXCEPTION 'FALLO: una versión de A pudo colgarse de la automatización de B';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS · FK compuesta: versión de A NO puede enlazar a automatización de B';
  END;

  -- Cambiar de contexto a B: ahora ve solo la de B (intacta, nada la secuestró).
  PERFORM set_config('app.current_org', b::text, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 1 THEN RAISE EXCEPTION 'FALLO: con org B esperaba 1, vi %', cnt; END IF;
  SELECT count(*) INTO cnt FROM automatizaciones WHERE nombre = 'B1';
  IF cnt <> 1 THEN RAISE EXCEPTION 'FALLO: la automatización de B fue alterada'; END IF;
  RAISE NOTICE 'PASS · cambio de contexto a B: ve su 1 automatización, intacta';

  -- Sin contexto → fail-closed: 0 filas (no un leak).
  PERFORM set_config('app.current_org', NULL, true);
  SELECT count(*) INTO cnt FROM automatizaciones;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FALLO FAIL-OPEN: sin contexto vi % filas', cnt; END IF;
  RAISE NOTICE 'PASS · fail-closed: sin org en la sesión no ve nada';

  RESET ROLE;
  RAISE NOTICE '── AISLAMIENTO CROSS-TENANT: 12/12 ✓ ──';
END $$;

ROLLBACK;
