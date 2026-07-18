<?php
/*
Plugin Name: WHITESTAG SEO/GEO Bridge
Description: Öffnet Yoast-Meta für REST + serviert /llms.txt + liest/schreibt Avada-Seitenoptionen (pyre_*).
Version: 0.2.2
*/
if (!defined('ABSPATH')) exit;

/**
 * Login des Bot-Benutzers, der llms.txt setzen darf.
 * Der Benutzer bleibt ein normaler REDAKTEUR — er bekommt hier lediglich die eine
 * zusätzliche, eng geschnittene Berechtigung `whitestag_manage_llms`.
 * Kein Administrator-Zugang nötig.
 */
if (!defined('WHITESTAG_SEO_GEO_BOT_LOGIN')) {
    define('WHITESTAG_SEO_GEO_BOT_LOGIN', 'seo-geo-bot');
}

/** Custom-Capability nur diesem einen Benutzer verleihen (kein Rollen-weiter Eingriff). */
add_filter('user_has_cap', function ($allcaps, $caps, $args, $user) {
    if (!empty($user->user_login) && $user->user_login === WHITESTAG_SEO_GEO_BOT_LOGIN) {
        $allcaps['whitestag_manage_llms'] = true;
    }
    return $allcaps;
}, 10, 4);

add_action('init', function () {
    $keys = [
        '_yoast_wpseo_title', '_yoast_wpseo_metadesc',
        '_yoast_wpseo_opengraph-title', '_yoast_wpseo_opengraph-description',
        '_yoast_wpseo_canonical', '_yoast_wpseo_focuskw',
    ];
    foreach (['post', 'page'] as $type) {
        foreach ($keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest' => true,
                'single'       => true,
                'type'         => 'string',
                'auth_callback'=> function () { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

add_action('init', function () {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if ($ua === '') return;
    $bots = ['GPTBot','ChatGPT-User','OAI-SearchBot','ClaudeBot','anthropic-ai',
             'Claude-User','PerplexityBot','Perplexity-User','Google-Extended',
             'CCBot','Bytespider','Amazonbot'];
    $hit = null;
    foreach ($bots as $b) { if (stripos($ua, $b) !== false) { $hit = $b; break; } }
    if ($hit === null) return;
    $week = gmdate('o-\WW');                       // ISO-Jahr + KW, z.B. 2026-W29
    $data = get_option('whitestag_ai_bot_hits', []);
    if (!is_array($data)) $data = [];
    if (!isset($data[$week])) $data[$week] = [];
    $data[$week][$hit] = ($data[$week][$hit] ?? 0) + 1;
    if (count($data) > 8) {                        // rollierend: 8 Wochen
        ksort($data);
        $data = array_slice($data, -8, null, true);
    }
    update_option('whitestag_ai_bot_hits', $data, false);
});

// Meta-Tag im <head> ausgeben, wenn GSC-Verifikationstoken gesetzt.
add_action('wp_head', function () {
    $token = get_option('whitestag_gsc_verification', '');
    if ($token !== '') {
        echo '<meta name="google-site-verification" content="' . esc_attr($token) . '" />' . "\n";
    }
});

add_action('rest_api_init', function () {
    register_rest_route('whitestag-seo-geo/v1', '/llms', [
        'methods'  => 'POST',
        'permission_callback' => function () {
            // Admins dürfen weiterhin; ansonsten nur der Bot mit der Custom-Capability.
            return current_user_can('whitestag_manage_llms') || current_user_can('manage_options');
        },
        'callback' => function ($req) {
            update_option('whitestag_llms_txt', (string) $req->get_param('content'));
            return ['ok' => true];
        },
    ]);

    // REST-Route zum Setzen des GSC-Verifikationstokens (nur Administratoren).
    register_rest_route('whitestag-seo-geo/v1', '/gsc-verify', [
        'methods' => 'POST',
        'permission_callback' => function () { return current_user_can('manage_options'); },
        'callback' => function ($req) {
            $token = sanitize_text_field((string) $req->get_param('token'));
            update_option('whitestag_gsc_verification', $token);
            return ['ok' => true];
        },
    ]);

    // --- Avada-Seitenoptionen (nur pyre_*-Meta) lesen/schreiben ---------------
    // Eng abgesteckt: ausschliesslich Schluessel mit Praefix "pyre_" (Avada Fusion
    // Page Options). Berechtigung: edit_posts. Kein Zugriff auf andere/private Meta.
    $pyre_perm = function () { return current_user_can('edit_posts'); };

    // Lesen: alle pyre_*-Felder eines Posts -> Diagnose (2026- vs 2024-Beitrag vergleichen)
    register_rest_route('whitestag-seo-geo/v1', '/pageopts/(?P<id>\d+)', [
        'methods'  => 'GET',
        'permission_callback' => $pyre_perm,
        'callback' => function ($req) {
            $id = (int) $req['id'];
            if (!get_post($id)) return new WP_Error('not_found', 'Post nicht gefunden', ['status' => 404]);
            $out = [];
            foreach (get_post_meta($id) as $k => $v) {
                if (strpos($k, 'pyre_') === 0) $out[$k] = maybe_unserialize($v[0]);
            }
            return ['id' => $id, 'pyre' => $out];
        },
    ]);

    // Schreiben: genau ein pyre_*-Feld setzen
    register_rest_route('whitestag-seo-geo/v1', '/pageopts', [
        'methods'  => 'POST',
        'permission_callback' => $pyre_perm,
        'callback' => function ($req) {
            $id  = (int) $req->get_param('id');
            $key = (string) $req->get_param('key');
            $val = (string) $req->get_param('value');
            if (!get_post($id)) return new WP_Error('not_found', 'Post nicht gefunden', ['status' => 404]);
            if (strpos($key, 'pyre_') !== 0) {
                return new WP_Error('forbidden_key', 'Nur pyre_*-Schluessel erlaubt', ['status' => 403]);
            }
            $old = get_post_meta($id, $key, true);
            update_post_meta($id, $key, $val);
            return ['ok' => true, 'id' => $id, 'key' => $key, 'old' => $old, 'new' => $val];
        },
    ]);

    register_rest_route('whitestag-seo-geo/v1', '/aibots', [
        'methods' => 'GET',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
        'callback' => function () {
            $d = get_option('whitestag_ai_bot_hits', []);
            return is_array($d) ? $d : [];
        },
    ]);
});

add_action('init', function () {
    if (isset($_SERVER['REQUEST_URI']) && strtok($_SERVER['REQUEST_URI'], '?') === '/llms.txt') {
        $c = get_option('whitestag_llms_txt', '');
        if ($c !== '') {
            header('Content-Type: text/plain; charset=utf-8');
            echo $c; exit;
        }
    }
});
