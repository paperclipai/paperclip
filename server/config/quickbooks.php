<?php

<?php

// config/quickbooks.php

return [
    'api_key' => env('QUICKBOOKS_API_KEY'),
    'api_secret' => env('QUICKBOOKS_API_SECRET'),
    'company_id' => env('QUICKBOOKS_COMPANY_ID'),
    'sandbox' => env('QUICKBOOKS_SANDBOX', true),
    'default_connection' => 'my_qb_connection',
];