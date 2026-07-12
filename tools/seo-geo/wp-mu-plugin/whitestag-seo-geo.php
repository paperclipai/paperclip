<?php
/*
Plugin Name: WHITESTAG SEO/GEO Bridge
Description: Öffnet Yoast-Meta für REST + serviert /llms.txt aus einer Option.
Version: 0.1.0
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
