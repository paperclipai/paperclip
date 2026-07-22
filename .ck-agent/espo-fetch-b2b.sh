#!/usr/bin/env bash
# Trigger Espo InboundEmail fetch for alan@treshermanos.ch (INBOX + Sent + Drafts).
# Espo daemon also runs CheckInboundEmails every 2 min; this is for manual/on-demand refresh.
set -euo pipefail
docker exec divino-crm-web php -r "
chdir('/var/www/html');
require 'bootstrap.php';
\$app = new Espo\Core\Application();
\$app->setupSystemUser();
\$factory = \$app->getContainer()->get('injectableFactory');
\$svc = \$factory->create('Espo\Core\Mail\Account\GroupAccount\Service');
\$svc->fetch('6a3b6c9037a527dec');
echo \"espo-fetch-b2b: ok\n\";
"