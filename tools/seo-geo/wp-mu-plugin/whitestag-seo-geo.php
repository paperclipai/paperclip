<?php
/*
Plugin Name: WHITESTAG SEO/GEO Bridge
Description: Öffnet Yoast-Meta für REST + serviert /llms.txt aus einer Option.
Version: 0.1.0
*/
if (!defined('ABSPATH')) exit;

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
        'permission_callback' => function () { return current_user_can('manage_options'); },
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
