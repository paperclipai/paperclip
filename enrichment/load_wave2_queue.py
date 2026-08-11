"""
Catalog queue loader.

Inserts catalog rows as 'pending' into the company-scoped enrichment queue,
skipping any source_row_id already present (idempotent). Rows use the same payload
format as the reference canary: {sku, category_tag, product_name, price_per_sqft,
raw_description}.

Usage:
  DATABASE_URL=postgresql://... ENRICHMENT_COMPANY_ID=<company-uuid> python3 enrichment/load_wave2_queue.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg2
import psycopg2.extras

# ---------------------------------------------------------------------------
# Catalog data — 150 SSI-HP rows spanning quartz, marble, granite/quartzite,
# porcelain, sintered stone, and travertine. Prices in $/sqft.
# ---------------------------------------------------------------------------
CATALOG_ROWS = [
    # --- Quartz slabs ---
    {"sku": "SSI-QTZ-0100", "category_tag": "quartz-slab", "product_name": "MSI Calacatta Laza Quartz", "price_per_sqft": 52.0, "raw_description": "White quartz with bold gray and gold veining. Polished finish. NSF 51 certified. Ideal for kitchen countertops and vanity tops."},
    {"sku": "SSI-QTZ-0101", "category_tag": "quartz-slab", "product_name": "Silestone Eternal Marquina Quartz", "price_per_sqft": 78.0, "raw_description": "Deep black quartz with white veining inspired by Marquina marble. Polished finish. GREENGUARD Gold certified. Suitable for dramatic kitchen islands."},
    {"sku": "SSI-QTZ-0102", "category_tag": "quartz-slab", "product_name": "Caesarstone Pure White Quartz", "price_per_sqft": 48.0, "raw_description": "Bright white quartz with uniform texture and minimal patterning. Polished finish. NSF 51 food-contact safe. Low maintenance kitchen worktop."},
    {"sku": "SSI-QTZ-0103", "category_tag": "quartz-slab", "product_name": "Cambria Annicca Quartz", "price_per_sqft": 92.0, "raw_description": "Soft white quartz with warm gray and taupe movement. Polished finish. Made in USA. GREENGUARD Gold and NSF 51 certified. High-end kitchen countertop."},
    {"sku": "SSI-QTZ-0104", "category_tag": "quartz-slab", "product_name": "MSI Sparkling Black Quartz", "price_per_sqft": 44.0, "raw_description": "Solid black quartz with subtle silver sparkle throughout. Polished finish. NSF 51 certified. Contemporary kitchen and bathroom applications."},
    {"sku": "SSI-QTZ-0105", "category_tag": "quartz-slab", "product_name": "Silestone Iconic White Quartz", "price_per_sqft": 55.0, "raw_description": "White quartz with light gray veining and subtle texture. Polished finish. Bacteriostatic protection. Kitchen countertops and commercial applications."},
    {"sku": "SSI-QTZ-0106", "category_tag": "quartz-slab", "product_name": "Caesarstone Statuario Nuvo Quartz", "price_per_sqft": 82.0, "raw_description": "Premium white quartz with bold gray veining mimicking Statuario marble. Polished. GREENGUARD Gold and NSF 51 certified. High-end kitchen island."},
    {"sku": "SSI-QTZ-0107", "category_tag": "quartz-slab", "product_name": "Cambria Brittanicca Quartz", "price_per_sqft": 95.0, "raw_description": "White quartz with dramatic gray veining. Polished finish. NSF 51 certified. Made in USA. Premium kitchen countertop and bathroom vanity."},
    {"sku": "SSI-QTZ-0108", "category_tag": "quartz-slab", "product_name": "MSI Aria Carrera Quartz", "price_per_sqft": 38.0, "raw_description": "White quartz with soft gray veining inspired by Carrara marble. Polished finish. NSF 51. Versatile for kitchen, bath, and commercial interiors."},
    {"sku": "SSI-QTZ-0109", "category_tag": "quartz-slab", "product_name": "Silestone Cemento Spa Quartz", "price_per_sqft": 62.0, "raw_description": "Cool gray quartz with matte concrete-inspired finish. Honed texture. GREENGUARD Gold. Contemporary kitchen countertops and commercial surfaces."},
    {"sku": "SSI-QTZ-0110", "category_tag": "quartz-slab", "product_name": "Caesarstone Raw Concrete Quartz", "price_per_sqft": 58.0, "raw_description": "Medium gray quartz with brushed concrete-inspired texture. Honed finish. NSF 51 certified. Industrial and minimalist kitchen design."},
    {"sku": "SSI-QTZ-0111", "category_tag": "quartz-slab", "product_name": "MSI Calacatta Verona Quartz", "price_per_sqft": 65.0, "raw_description": "Warm white quartz with gold and gray veining. Polished. NSF 51. Kitchen countertops and master bathroom vanity tops."},
    {"sku": "SSI-QTZ-0112", "category_tag": "quartz-slab", "product_name": "Cambria Ironsbridge Quartz", "price_per_sqft": 88.0, "raw_description": "Light gray quartz with subtle movement and wispy texture. Polished. Made in USA. NSF 51. Luxury residential kitchen and bath countertops."},
    {"sku": "SSI-QTZ-0113", "category_tag": "quartz-slab", "product_name": "Silestone Blanco Zeus Quartz", "price_per_sqft": 45.0, "raw_description": "Solid white quartz with consistent texture. Polished finish. GREENGUARD Gold certified. Clean modern kitchen and commercial surfaces."},
    {"sku": "SSI-QTZ-0114", "category_tag": "quartz-slab", "product_name": "Caesarstone Vanilla Noir Quartz", "price_per_sqft": 72.0, "raw_description": "Dramatic black quartz with delicate white veining. Polished. NSF 51. High-contrast kitchen islands and bathroom feature walls."},

    # --- Marble slabs ---
    {"sku": "SSI-MBL-0100", "category_tag": "marble-slab", "product_name": "Calacatta Gold Marble Slab", "price_per_sqft": 140.0, "raw_description": "Premium Italian Calacatta marble with bold gold and gray veining on bright white background. Polished. High-end kitchen countertops and bathroom vanity tops."},
    {"sku": "SSI-MBL-0101", "category_tag": "marble-slab", "product_name": "Nero Marquina Marble Slab", "price_per_sqft": 95.0, "raw_description": "Deep black Spanish marble with crisp white veining. Polished or honed finish available. Dramatic kitchen islands, fireplace surrounds, and flooring."},
    {"sku": "SSI-MBL-0102", "category_tag": "marble-slab", "product_name": "Crema Marfil Marble Slab", "price_per_sqft": 45.0, "raw_description": "Warm beige Spanish marble with light fossil inclusions. Polished finish. Bathroom flooring, wall cladding, and countertop applications."},
    {"sku": "SSI-MBL-0103", "category_tag": "marble-slab", "product_name": "Thassos White Marble Slab", "price_per_sqft": 85.0, "raw_description": "Pure white Greek marble with minimal veining. Polished finish. Ultra-white marble for luxury bathrooms and feature walls."},
    {"sku": "SSI-MBL-0104", "category_tag": "marble-slab", "product_name": "Portoro Gold Marble Slab", "price_per_sqft": 175.0, "raw_description": "Rare Italian black marble with dramatic gold and white veining. Polished. Exclusive kitchen islands and luxury bathroom feature walls."},
    {"sku": "SSI-MBL-0105", "category_tag": "marble-slab", "product_name": "Silver Travertine Marble Slab", "price_per_sqft": 32.0, "raw_description": "Silver-gray travertine with natural pitting and linear veining. Filled and honed finish. Flooring, wall tile, and outdoor applications."},
    {"sku": "SSI-MBL-0106", "category_tag": "marble-slab", "product_name": "Emprador Dark Marble Slab", "price_per_sqft": 78.0, "raw_description": "Rich brown Spanish marble with white and beige veining. Polished finish. Luxury bathroom vanity tops and statement kitchen islands."},
    {"sku": "SSI-MBL-0107", "category_tag": "marble-slab", "product_name": "Arabescato Corchia Marble Slab", "price_per_sqft": 165.0, "raw_description": "Premium Italian white marble with bold dramatic gray veining. Polished. High-end residential kitchen countertops and bath surrounds."},
    {"sku": "SSI-MBL-0108", "category_tag": "marble-slab", "product_name": "Verde Alpi Marble Slab", "price_per_sqft": 210.0, "raw_description": "Rare Italian dark green marble with white calcite veining. Polished. Accent walls, feature countertops, and luxury commercial interiors."},
    {"sku": "SSI-MBL-0109", "category_tag": "marble-slab", "product_name": "Rosa Portogallo Marble Slab", "price_per_sqft": 68.0, "raw_description": "Pink-toned Portuguese marble with white and gray veining. Polished. Bathroom vanity tops, flooring, and decorative wall applications."},
    {"sku": "SSI-MBL-0110", "category_tag": "marble-slab", "product_name": "Pietra Grey Marble Slab", "price_per_sqft": 90.0, "raw_description": "Dark gray Iranian marble with fine white veining. Polished or honed finish. Kitchen countertops, bathroom floors, and wall cladding."},
    {"sku": "SSI-MBL-0111", "category_tag": "marble-slab", "product_name": "Botticino Classico Marble Slab", "price_per_sqft": 55.0, "raw_description": "Warm beige-cream Italian marble with subtle tan veining. Polished. Flooring, wall tile, countertops, and commercial cladding."},
    {"sku": "SSI-MBL-0112", "category_tag": "marble-slab", "product_name": "Onyx White Marble Slab", "price_per_sqft": 280.0, "raw_description": "Translucent white onyx marble with honey-gold veining. Backlit feature walls and luxury countertop applications. Exclusive residential use."},
    {"sku": "SSI-MBL-0113", "category_tag": "marble-slab", "product_name": "Panda White Marble Slab", "price_per_sqft": 72.0, "raw_description": "Chinese white marble with bold black veining. Polished. Dramatic kitchen countertops and bathroom feature walls in contemporary spaces."},
    {"sku": "SSI-MBL-0114", "category_tag": "marble-slab", "product_name": "Silver Shadow Marble Slab", "price_per_sqft": 85.0, "raw_description": "Light gray Turkish marble with subtle veining and consistent texture. Polished or honed. Bathroom flooring, wall tile, and countertops."},

    # --- Granite/quartzite slabs ---
    {"sku": "SSI-GRN-0100", "category_tag": "granite-slab", "product_name": "Ubatuba Green Granite Slab", "price_per_sqft": 35.0, "raw_description": "Dark green Brazilian granite with gold and black mineral flecks. Polished. Kitchen countertops, outdoor kitchens, and commercial applications."},
    {"sku": "SSI-GRN-0101", "category_tag": "granite-slab", "product_name": "Kashmir White Granite Slab", "price_per_sqft": 42.0, "raw_description": "White Indian granite with black, red, and gray mineral patterns. Polished. Kitchen countertops and bathroom vanity tops. Heat and scratch resistant."},
    {"sku": "SSI-GRN-0102", "category_tag": "granite-slab", "product_name": "Absolute Black Granite Slab", "price_per_sqft": 38.0, "raw_description": "Deep solid black Indian granite. Polished or leather finish. Contemporary kitchen countertops and commercial flooring. Uniform appearance."},
    {"sku": "SSI-GRN-0103", "category_tag": "granite-slab", "product_name": "Colonial White Granite Slab", "price_per_sqft": 36.0, "raw_description": "White Brazilian granite with gray and dark mineral flecks. Polished. Affordable kitchen countertop with consistent white background."},
    {"sku": "SSI-GRN-0104", "category_tag": "granite-slab", "product_name": "Blue Pearl Granite Slab", "price_per_sqft": 55.0, "raw_description": "Norwegian gray-blue granite with iridescent blue labradorite mineral. Polished. Distinctive kitchen island countertops and commercial surfaces."},
    {"sku": "SSI-GRN-0105", "category_tag": "granite-slab", "product_name": "Bianco Romano Granite Slab", "price_per_sqft": 40.0, "raw_description": "White Brazilian granite with gray and black mineral clusters. Polished. Budget-friendly kitchen countertop with marble-like appearance."},
    {"sku": "SSI-GRN-0106", "category_tag": "granite-slab", "product_name": "Santa Cecilia Granite Slab", "price_per_sqft": 33.0, "raw_description": "Golden-beige Brazilian granite with black and gray mineral spots. Polished. Popular value kitchen countertop. Heat and scratch resistant."},
    {"sku": "SSI-GRN-0107", "category_tag": "granite-slab", "product_name": "Giallo Ornamental Granite Slab", "price_per_sqft": 32.0, "raw_description": "Cream and gold Brazilian granite with dark mineral swirls. Polished. Affordable kitchen countertops. Widely available in stock. Heat resistant."},
    {"sku": "SSI-GRN-0108", "category_tag": "granite-slab", "product_name": "New Venetian Gold Granite Slab", "price_per_sqft": 35.0, "raw_description": "Gold and cream Brazilian granite with dark veining and mineral patterns. Polished. Entry-level granite for kitchen countertops. In stock."},
    {"sku": "SSI-GRN-0109", "category_tag": "granite-slab", "product_name": "Alaska White Granite Slab", "price_per_sqft": 38.0, "raw_description": "Light gray Indian granite with white and dark mineral inclusions. Polished. Kitchen countertops and bathroom vanity tops. Heat resistant."},
    {"sku": "SSI-GRN-0110", "category_tag": "granite-slab", "product_name": "Verde Butterfly Granite Slab", "price_per_sqft": 48.0, "raw_description": "Green Brazilian granite with dark swirling patterns. Polished. Distinctive kitchen countertops and outdoor applications. Heat and frost resistant."},
    {"sku": "SSI-GRN-0111", "category_tag": "granite-slab", "product_name": "Azul Bahia Granite Slab", "price_per_sqft": 195.0, "raw_description": "Rare vivid blue Brazilian granite. Polished. One of the rarest granites available. Exclusive kitchen islands and luxury commercial installations."},
    {"sku": "SSI-GRN-0112", "category_tag": "granite-slab", "product_name": "River White Granite Slab", "price_per_sqft": 42.0, "raw_description": "White Indian granite with fine gray and rust mineral flecks. Polished. Kitchen countertops and bathroom vanity. Consistent white background."},
    {"sku": "SSI-GRN-0113", "category_tag": "granite-slab", "product_name": "Viscount White Granite Slab", "price_per_sqft": 40.0, "raw_description": "Light gray Brazilian granite with cream and black mineral movement. Polished. Kitchen countertops and commercial worktops. Heat resistant."},
    {"sku": "SSI-GRN-0114", "category_tag": "granite-slab", "product_name": "Steel Grey Granite Slab", "price_per_sqft": 38.0, "raw_description": "Uniform steel gray Indian granite. Polished. Commercial flooring, outdoor cladding, and contemporary kitchen countertops. Highly durable."},

    # --- Quartzite slabs ---
    {"sku": "SSI-QZT-0100", "category_tag": "quartzite-slab", "product_name": "Super White Quartzite Slab", "price_per_sqft": 85.0, "raw_description": "White Brazilian quartzite with soft gray veining resembling marble. Polished or honed. High-end kitchen countertops. Harder and more durable than marble."},
    {"sku": "SSI-QZT-0101", "category_tag": "quartzite-slab", "product_name": "Sea Pearl Quartzite Slab", "price_per_sqft": 95.0, "raw_description": "Gray quartzite with white and green mineral movement. Polished. Unique kitchen countertops and bathroom vanity tops. Natural quartzite — heat resistant."},
    {"sku": "SSI-QZT-0102", "category_tag": "quartzite-slab", "product_name": "Taj Mahal Quartzite Slab", "price_per_sqft": 110.0, "raw_description": "Creamy white Brazilian quartzite with soft gold veining. Polished or leathered. Premium kitchen countertops and luxury bathroom vanity. Durable."},
    {"sku": "SSI-QZT-0103", "category_tag": "quartzite-slab", "product_name": "Calacatta Macaubas Quartzite Slab", "price_per_sqft": 125.0, "raw_description": "White quartzite with dramatic blue-gray veining. Polished. Exotic kitchen islands and high-end residential countertops. Natural quartzite."},
    {"sku": "SSI-QZT-0104", "category_tag": "quartzite-slab", "product_name": "Fusion Wow Quartzite Slab", "price_per_sqft": 145.0, "raw_description": "Dramatic multi-color Brazilian quartzite with swirling colors. Polished. Statement kitchen islands. One-of-a-kind natural stone slab."},
    {"sku": "SSI-QZT-0105", "category_tag": "quartzite-slab", "product_name": "White Macaubas Quartzite Slab", "price_per_sqft": 98.0, "raw_description": "Soft white quartzite with light gray movement. Polished or honed. Kitchen countertops and bath vanities. More durable alternative to marble."},
    {"sku": "SSI-QZT-0106", "category_tag": "quartzite-slab", "product_name": "Cristallo Quartzite Slab", "price_per_sqft": 155.0, "raw_description": "White translucent quartzite with gold and blue-gray veining. Polished. Premium kitchen countertops and luxury vanities. Rare and exclusive slab."},
    {"sku": "SSI-QZT-0107", "category_tag": "quartzite-slab", "product_name": "Azul Macaubas Quartzite Slab", "price_per_sqft": 120.0, "raw_description": "Blue and gray Brazilian quartzite with distinctive movement. Polished. Unique kitchen islands and luxury feature countertops. Natural quartzite."},
    {"sku": "SSI-QZT-0108", "category_tag": "quartzite-slab", "product_name": "Amazonia Quartzite Slab", "price_per_sqft": 88.0, "raw_description": "Green-toned quartzite with swirling movement. Polished. Distinctive kitchen and bathroom countertops. Durable natural quartzite."},
    {"sku": "SSI-QZT-0109", "category_tag": "quartzite-slab", "product_name": "Calacatta Viola Quartzite Slab", "price_per_sqft": 135.0, "raw_description": "White quartzite with purple and gray veining. Polished. Exclusive kitchen countertops. Rare natural quartzite — limited availability."},
    {"sku": "SSI-QZT-0110", "category_tag": "quartzite-slab", "product_name": "Brown Leather Quartzite Slab", "price_per_sqft": 78.0, "raw_description": "Golden-brown quartzite with linear movement. Leathered or polished finish. Kitchen countertops and outdoor applications. Heat and frost resistant."},

    # --- Porcelain tile ---
    {"sku": "SSI-PRC-0100", "category_tag": "porcelain-tile", "product_name": "Wood Look Porcelain Plank 6x36", "price_per_sqft": 4.50, "raw_description": "Porcelain plank with realistic oak wood visual. Matte rectified finish. Frost-resistant. Suitable for residential and light commercial flooring."},
    {"sku": "SSI-PRC-0101", "category_tag": "porcelain-tile", "product_name": "Marble Look Polished Porcelain 24x24", "price_per_sqft": 7.25, "raw_description": "Large format porcelain with polished Carrara marble visual. Rectified. Interior flooring, walls, and countertop applications."},
    {"sku": "SSI-PRC-0102", "category_tag": "porcelain-tile", "product_name": "Basalt Look Matte Porcelain 12x24", "price_per_sqft": 5.50, "raw_description": "Dark gray porcelain with matte basalt texture. Frost-resistant. Floor and wall applications, indoor and outdoor use."},
    {"sku": "SSI-PRC-0103", "category_tag": "porcelain-tile", "product_name": "Calacatta Marble Porcelain 32x32", "price_per_sqft": 9.50, "raw_description": "Large format polished porcelain with Calacatta marble pattern. Rectified edges. Interior flooring, feature walls, and commercial applications."},
    {"sku": "SSI-PRC-0104", "category_tag": "porcelain-tile", "product_name": "Travertine Look Porcelain 18x18", "price_per_sqft": 4.75, "raw_description": "Porcelain with filled travertine visual. Matte finish. Suitable for interior floor and wall applications. Commercial grade."},
    {"sku": "SSI-PRC-0105", "category_tag": "porcelain-tile", "product_name": "Slate Look Outdoor Porcelain 24x24", "price_per_sqft": 6.00, "raw_description": "Textured porcelain with slate visual. High-slip resistance. Frost-resistant for pool decks, patios, and outdoor flooring."},
    {"sku": "SSI-PRC-0106", "category_tag": "porcelain-tile", "product_name": "White Gloss Subway Porcelain 3x12", "price_per_sqft": 3.25, "raw_description": "Classic white glossy subway tile. Rectified porcelain. Kitchen backsplash and bathroom wall applications. Classic and versatile."},
    {"sku": "SSI-PRC-0107", "category_tag": "porcelain-tile", "product_name": "Terrazzo Look Polished Porcelain 24x24", "price_per_sqft": 8.75, "raw_description": "Large format polished porcelain with terrazzo visual. Colorful chip pattern. Interior flooring and commercial feature floors."},
    {"sku": "SSI-PRC-0108", "category_tag": "porcelain-tile", "product_name": "Grigio Concrete Matte Porcelain 48x48", "price_per_sqft": 12.50, "raw_description": "Extra-large format matte gray porcelain with concrete look. Rectified. Commercial and residential large-format floor and wall installations."},
    {"sku": "SSI-PRC-0109", "category_tag": "porcelain-tile", "product_name": "Bianco Marble Honed Porcelain 24x48", "price_per_sqft": 10.25, "raw_description": "Large format honed porcelain with white marble visual. Rectified. Bathroom walls, feature floors, and commercial applications."},
    {"sku": "SSI-PRC-0110", "category_tag": "porcelain-tile", "product_name": "Taupe Limestone Porcelain 12x24", "price_per_sqft": 5.25, "raw_description": "Warm taupe porcelain with limestone texture. Matte rectified. Interior and exterior floor applications. Frost-resistant."},
    {"sku": "SSI-PRC-0111", "category_tag": "porcelain-tile", "product_name": "Nero Marquina Marble Porcelain 24x24", "price_per_sqft": 8.00, "raw_description": "Polished porcelain with Nero Marquina black marble visual. Rectified. Interior floor and wall applications in modern spaces."},
    {"sku": "SSI-PRC-0112", "category_tag": "porcelain-tile", "product_name": "Sandstone Look Outdoor Porcelain 18x36", "price_per_sqft": 7.50, "raw_description": "Porcelain with sandstone texture. Anti-slip surface. Suitable for outdoor patios, pool decks, and walkways. Frost-resistant."},
    {"sku": "SSI-PRC-0113", "category_tag": "porcelain-tile", "product_name": "White Polished Rectified Porcelain 24x48", "price_per_sqft": 6.75, "raw_description": "Solid white polished porcelain with minimal veining. Rectified. Commercial and residential floors and walls."},
    {"sku": "SSI-PRC-0114", "category_tag": "porcelain-tile", "product_name": "Ash Wood Plank Porcelain 8x48", "price_per_sqft": 5.75, "raw_description": "Long plank porcelain with ash wood visual. Matte rectified. Residential flooring and wall applications. Frost-resistant."},

    # --- Sintered stone / ultracompact ---
    {"sku": "SSI-SIN-0100", "category_tag": "sintered-stone-slab", "product_name": "Dekton Ventus Sintered Stone 20mm", "price_per_sqft": 145.0, "raw_description": "Ultracompact sintered stone with warm beige concrete look. Matte finish. 20mm thickness for outdoor kitchen countertops and cladding. UV and frost resistant."},
    {"sku": "SSI-SIN-0101", "category_tag": "sintered-stone-slab", "product_name": "Neolith Arctic White Sintered Stone 12mm", "price_per_sqft": 118.0, "raw_description": "Pure white sintered stone with subtle texture. Polished. Kitchen countertops, bathroom vanity tops. Stain, scratch, and heat resistant."},
    {"sku": "SSI-SIN-0102", "category_tag": "sintered-stone-slab", "product_name": "Lapitec Bianco Polare Sintered 12mm", "price_per_sqft": 132.0, "raw_description": "White sintered stone with consistent polished surface. Kitchen countertops and wall cladding. Antibacterial. High chemical resistance."},
    {"sku": "SSI-SIN-0103", "category_tag": "sintered-stone-slab", "product_name": "Dekton Kreta Sintered Stone 12mm", "price_per_sqft": 138.0, "raw_description": "Warm sand-colored ultracompact stone with matte finish. Outdoor and indoor countertops. UV stable, frost-proof, scratch-resistant."},
    {"sku": "SSI-SIN-0104", "category_tag": "sintered-stone-slab", "product_name": "Neolith Calacatta Sintered Stone 12mm", "price_per_sqft": 125.0, "raw_description": "Sintered stone with Calacatta marble pattern. Polished. Kitchen countertops and bathroom walls. Combines marble aesthetics with technical performance."},
    {"sku": "SSI-SIN-0105", "category_tag": "sintered-stone-slab", "product_name": "Lapitec Nero Assoluto Sintered 12mm", "price_per_sqft": 128.0, "raw_description": "Deep black sintered stone with ultra-matte finish. Kitchen countertops and feature walls. Scratch and stain resistant. Professional-grade material."},
    {"sku": "SSI-SIN-0106", "category_tag": "sintered-stone-slab", "product_name": "Dekton Laurent Sintered Stone 8mm", "price_per_sqft": 98.0, "raw_description": "Thin 8mm sintered stone with dark concrete look. Ultralight for wall cladding and furniture tops. Heat and scratch resistant."},
    {"sku": "SSI-SIN-0107", "category_tag": "sintered-stone-slab", "product_name": "Neolith Estatuario Sintered Stone 12mm", "price_per_sqft": 135.0, "raw_description": "White sintered stone with Statuario marble veining. Polished. High-end kitchen and bath countertops. Hygienic and food-safe surface."},
    {"sku": "SSI-SIN-0108", "category_tag": "sintered-stone-slab", "product_name": "Lapitec Grigio Piombo Sintered 12mm", "price_per_sqft": 122.0, "raw_description": "Dark gray sintered stone with matte finish. Industrial-style kitchen countertops and commercial surfaces. Highly resistant to impact and chemicals."},
    {"sku": "SSI-SIN-0109", "category_tag": "sintered-stone-slab", "product_name": "Dekton Opera Sintered Stone 12mm", "price_per_sqft": 155.0, "raw_description": "White ultracompact stone with dramatic gray marble veining. Polished. Premium kitchen countertops and luxury bathroom design."},
    {"sku": "SSI-SIN-0110", "category_tag": "sintered-stone-slab", "product_name": "Neolith Iron Corten Sintered 12mm", "price_per_sqft": 142.0, "raw_description": "Rust-toned sintered stone with industrial Corten look. Matte. Kitchen countertops, outdoor cladding, and commercial interiors. UV stable."},

    # --- Travertine ---
    {"sku": "SSI-TRV-0100", "category_tag": "travertine-slab", "product_name": "Classic Ivory Travertine Slab", "price_per_sqft": 18.0, "raw_description": "Classic ivory travertine with natural pitting. Filled and honed. Flooring, wall tile, and countertop applications. Suitable for indoor and outdoor use."},
    {"sku": "SSI-TRV-0101", "category_tag": "travertine-slab", "product_name": "Walnut Travertine Slab", "price_per_sqft": 22.0, "raw_description": "Dark walnut-toned travertine with natural veining. Filled and honed or polished. Interior flooring, bathroom walls, and countertop applications."},
    {"sku": "SSI-TRV-0102", "category_tag": "travertine-slab", "product_name": "Noce Travertine Slab", "price_per_sqft": 20.0, "raw_description": "Warm brown travertine with rich veining. Filled and honed. Interior and exterior flooring and wall applications. Classic Mediterranean look."},
    {"sku": "SSI-TRV-0103", "category_tag": "travertine-slab", "product_name": "Silver Travertine Slab", "price_per_sqft": 24.0, "raw_description": "Silver-gray travertine with linear veining. Filled and polished or honed. Flooring, bathroom walls, and outdoor pool coping."},
    {"sku": "SSI-TRV-0104", "category_tag": "travertine-slab", "product_name": "Gold Vein Travertine Slab", "price_per_sqft": 28.0, "raw_description": "Cream travertine with prominent gold and amber veining. Filled and polished. Feature walls, bathroom vanity tops, and decorative flooring."},
    {"sku": "SSI-TRV-0105", "category_tag": "travertine-slab", "product_name": "Persian Walnut Travertine Slab", "price_per_sqft": 26.0, "raw_description": "Iranian walnut travertine with rich brown tones. Filled and honed. Interior flooring, feature walls, and countertop applications."},

    # --- Limestone ---
    {"sku": "SSI-LMS-0100", "category_tag": "limestone-slab", "product_name": "Jerusalem Gold Limestone Slab", "price_per_sqft": 28.0, "raw_description": "Honey-gold Israeli limestone with fossil inclusions. Honed finish. Interior flooring, wall tile, and countertop applications."},
    {"sku": "SSI-LMS-0101", "category_tag": "limestone-slab", "product_name": "Jura Gray Limestone Slab", "price_per_sqft": 35.0, "raw_description": "Cool gray German limestone with natural fossil detail. Honed. Interior flooring, wall cladding, and countertop applications. Elegant and durable."},
    {"sku": "SSI-LMS-0102", "category_tag": "limestone-slab", "product_name": "Comblanchien Limestone Slab", "price_per_sqft": 45.0, "raw_description": "French gray limestone with fine texture. Honed. Interior and exterior flooring, wall cladding. Used in prestige construction projects."},
    {"sku": "SSI-LMS-0103", "category_tag": "limestone-slab", "product_name": "Moca Cream Limestone Slab", "price_per_sqft": 32.0, "raw_description": "Cream Portuguese limestone with fine texture and fossil inclusions. Honed or brushed. Interior flooring, walls, and stairs."},
    {"sku": "SSI-LMS-0104", "category_tag": "limestone-slab", "product_name": "Azul Valverde Limestone Slab", "price_per_sqft": 38.0, "raw_description": "Blue-gray Portuguese limestone with consistent fine texture. Honed. Interior flooring and wall cladding. Classic European stone."},

    # --- Slate ---
    {"sku": "SSI-SLT-0100", "category_tag": "slate-tile", "product_name": "Black Slate Natural Cleft Tile 12x12", "price_per_sqft": 6.50, "raw_description": "Natural black slate with cleft surface. Suitable for interior and exterior flooring, bathroom walls, and garden paths. Frost-resistant."},
    {"sku": "SSI-SLT-0101", "category_tag": "slate-tile", "product_name": "Multicolor Slate Natural Cleft Tile 12x12", "price_per_sqft": 5.75, "raw_description": "Slate tile with natural color variation in green, purple, and rust tones. Cleft surface. Indoor and outdoor flooring and wall applications."},
    {"sku": "SSI-SLT-0102", "category_tag": "slate-tile", "product_name": "Green Slate Honed Tile 12x24", "price_per_sqft": 7.25, "raw_description": "Green slate with honed finish for smoother texture. Interior flooring and bathroom applications. Non-slip surface naturally."},

    # --- Engineered stone / solid surface ---
    {"sku": "SSI-ENG-0100", "category_tag": "engineered-stone-slab", "product_name": "Corian White Solid Surface", "price_per_sqft": 35.0, "raw_description": "Solid white acrylic solid surface. Seamless joins. Kitchen countertops, bathroom vanity, and commercial worktops. Renewable surface."},
    {"sku": "SSI-ENG-0101", "category_tag": "engineered-stone-slab", "product_name": "HI-MACS Glacier White Solid Surface", "price_per_sqft": 32.0, "raw_description": "Bright white solid acrylic surface. Non-porous and hygienic. Kitchen countertops and commercial food-prep applications."},
    {"sku": "SSI-ENG-0102", "category_tag": "engineered-stone-slab", "product_name": "Avonite Warm Gray Solid Surface", "price_per_sqft": 38.0, "raw_description": "Warm gray solid surface with consistent texture. Thermoformable. Countertops, wall panels, and custom furniture tops."},
    {"sku": "SSI-ENG-0103", "category_tag": "engineered-stone-slab", "product_name": "Staron Aspen White Solid Surface", "price_per_sqft": 30.0, "raw_description": "White solid surface with translucent mineral particles. Seamless installation. Kitchen countertops and vanity tops. Renewable finish."},

    # --- Additional quartz (mid-market, high-volume) ---
    {"sku": "SSI-QTZ-0200", "category_tag": "quartz-slab", "product_name": "MSI Everest Quartz", "price_per_sqft": 40.0, "raw_description": "White quartz with soft gray veining. Polished finish. NSF 51 certified. Mainstream kitchen countertop. High availability and consistent color."},
    {"sku": "SSI-QTZ-0201", "category_tag": "quartz-slab", "product_name": "Allen & Roth Arctic White Quartz", "price_per_sqft": 32.0, "raw_description": "Bright white quartz with minimal veining. Polished. Entry-level quartz for budget kitchen renovations. Available in standard sizes."},
    {"sku": "SSI-QTZ-0202", "category_tag": "quartz-slab", "product_name": "Formica White Quartz", "price_per_sqft": 28.0, "raw_description": "White engineered quartz with consistent look. Polished. Budget-friendly kitchen countertop for rental properties and volume projects."},
    {"sku": "SSI-QTZ-0203", "category_tag": "quartz-slab", "product_name": "Viatera Muse Quartz", "price_per_sqft": 42.0, "raw_description": "White quartz with soft veining. Polished. NSF 51 food-safe. Kitchen countertops. Made in USA. Mid-market residential and light commercial."},
    {"sku": "SSI-QTZ-0204", "category_tag": "quartz-slab", "product_name": "Pental Quartz Pure White", "price_per_sqft": 38.0, "raw_description": "Solid white quartz with polished finish. NSF 51. Kitchen countertops and bathroom vanity. Consistent appearance across slabs."},
    {"sku": "SSI-QTZ-0205", "category_tag": "quartz-slab", "product_name": "MSI Calacatta Diva Quartz", "price_per_sqft": 55.0, "raw_description": "White quartz with warm gold veining. Polished. NSF 51 certified. Mid-to-high market kitchen countertops and vanity tops."},
    {"sku": "SSI-QTZ-0206", "category_tag": "quartz-slab", "product_name": "Silestone Niebla Quartz", "price_per_sqft": 68.0, "raw_description": "Light gray quartz with misty, uniform texture. Polished. GREENGUARD Gold. Contemporary kitchen countertops and commercial worktops."},
    {"sku": "SSI-QTZ-0207", "category_tag": "quartz-slab", "product_name": "Caesarstone Cloudburst Concrete Quartz", "price_per_sqft": 62.0, "raw_description": "Gray quartz with concrete-inspired texture. Honed finish. NSF 51 certified. Industrial and modern kitchen countertop applications."},
    {"sku": "SSI-QTZ-0208", "category_tag": "quartz-slab", "product_name": "Cambria Torquay Quartz", "price_per_sqft": 85.0, "raw_description": "White quartz with bold veining. Polished. Made in USA. NSF 51. Luxury kitchen and bath. High-end residential specification."},
    {"sku": "SSI-QTZ-0209", "category_tag": "quartz-slab", "product_name": "MSI Midnight Majesty Quartz", "price_per_sqft": 48.0, "raw_description": "Deep black quartz with gold metallic veining. Polished. NSF 51. Dramatic kitchen countertops and bar tops. High-contrast design."},

    # --- Additional porcelain (large format, trending) ---
    {"sku": "SSI-PRC-0200", "category_tag": "porcelain-tile", "product_name": "Calacatta Gold Polished Porcelain 48x96", "price_per_sqft": 18.50, "raw_description": "Jumbo slab-format porcelain with Calacatta Gold pattern. Polished rectified. Interior flooring, countertops, and feature walls."},
    {"sku": "SSI-PRC-0201", "category_tag": "porcelain-tile", "product_name": "Ocean Blue Matte Porcelain 24x48", "price_per_sqft": 11.25, "raw_description": "Blue-toned matte porcelain with subtle wave movement. Rectified. Bathroom walls, feature floors, and commercial accent walls."},
    {"sku": "SSI-PRC-0202", "category_tag": "porcelain-tile", "product_name": "Sahara Desert Matte Porcelain 24x24", "price_per_sqft": 7.75, "raw_description": "Warm sand porcelain with desert-inspired texture. Matte. Frost-resistant outdoor and indoor flooring. Slip-resistant profile."},
    {"sku": "SSI-PRC-0203", "category_tag": "porcelain-tile", "product_name": "Herringbone White Wood Porcelain Mosaic", "price_per_sqft": 14.00, "raw_description": "White wood-look porcelain in herringbone mosaic format. Matte. Backsplash, bathroom floor, and accent floor applications."},
    {"sku": "SSI-PRC-0204", "category_tag": "porcelain-tile", "product_name": "Zen Wabi Matte Porcelain 24x48", "price_per_sqft": 9.50, "raw_description": "Light warm gray matte porcelain with subtle texture. Rectified. Bathroom floors and walls. Spa-inspired minimalist aesthetic."},
    {"sku": "SSI-PRC-0205", "category_tag": "porcelain-tile", "product_name": "Fossil Stone Matte Porcelain 18x36", "price_per_sqft": 8.25, "raw_description": "Beige porcelain with fossil stone visual. Matte rectified. Interior and exterior flooring. Frost-resistant."},

    # --- Mosaic tile ---
    {"sku": "SSI-MOS-0100", "category_tag": "mosaic-tile", "product_name": "Carrara White Marble Hexagon Mosaic 2in", "price_per_sqft": 24.0, "raw_description": "Carrara marble mosaic in 2-inch hexagon format. Polished. Bathroom floor, shower floor, and backsplash. Mesh-backed for easy installation."},
    {"sku": "SSI-MOS-0101", "category_tag": "mosaic-tile", "product_name": "Subway Glass Mosaic 1x2 White", "price_per_sqft": 18.0, "raw_description": "Glossy white glass subway mosaic tile. Kitchen backsplash and bathroom accent walls. Mesh-backed. Bright reflective surface."},
    {"sku": "SSI-MOS-0102", "category_tag": "mosaic-tile", "product_name": "Penny Round Carrara Marble Mosaic", "price_per_sqft": 22.0, "raw_description": "White Carrara marble penny round mosaic. Polished. Bathroom floor, shower floor, and accent wall applications. Mesh-backed."},
    {"sku": "SSI-MOS-0103", "category_tag": "mosaic-tile", "product_name": "Glass and Stone Blend Mosaic 12x12", "price_per_sqft": 28.0, "raw_description": "Mixed glass and natural stone mosaic in gray and white tones. Kitchen backsplash and bathroom walls. Iridescent glass accents."},
    {"sku": "SSI-MOS-0104", "category_tag": "mosaic-tile", "product_name": "Fish Scale Fan Marble Mosaic", "price_per_sqft": 32.0, "raw_description": "White Thassos marble in scallop fan (fish scale) mosaic pattern. Polished. Decorative bathroom walls and shower niches."},

    # --- Outdoor / pavers ---
    {"sku": "SSI-PAV-0100", "category_tag": "paver-tile", "product_name": "Natural Travertine Paver 16x16 Tumbled", "price_per_sqft": 6.50, "raw_description": "Tumbled travertine paver. Natural aged look. Pool decking, patio, and walkway applications. Frost-resistant. Unfilled natural surface."},
    {"sku": "SSI-PAV-0101", "category_tag": "paver-tile", "product_name": "Basalt Paver 24x24 Flamed", "price_per_sqft": 14.0, "raw_description": "Flamed dark basalt paver. High slip resistance. Pool decks, patios, and commercial outdoor spaces. Frost and UV resistant."},
    {"sku": "SSI-PAV-0102", "category_tag": "paver-tile", "product_name": "Granite Cobble Paver 4x4", "price_per_sqft": 8.50, "raw_description": "Natural granite cobblestone paver. Tumbled finish. Driveways, garden paths, and outdoor feature areas. Extremely durable."},
    {"sku": "SSI-PAV-0103", "category_tag": "paver-tile", "product_name": "Limestone Paver 24x24 Brushed", "price_per_sqft": 11.0, "raw_description": "Brushed limestone paver. Slip-resistant. Pool decking, patio, and walkway use. Natural look with consistent cream tones."},

    # --- Bathroom specialty ---
    {"sku": "SSI-BFT-0100", "category_tag": "bathroom-floor-tile", "product_name": "Non-Slip Matte Black Porcelain 12x12", "price_per_sqft": 5.25, "raw_description": "Black matte non-slip porcelain tile. DCOf >0.42. Wet area and shower floor use. ADA compliant surface profile."},
    {"sku": "SSI-BFT-0101", "category_tag": "bathroom-floor-tile", "product_name": "Ceramic Hex White Matte 2in Bathroom Floor", "price_per_sqft": 3.50, "raw_description": "White matte ceramic hexagon tile in 2-inch format. Classic bathroom floor tile. Mesh-backed for easy installation. Grout joint spacing 1/16 inch."},
    {"sku": "SSI-BFT-0102", "category_tag": "bathroom-floor-tile", "product_name": "Pebble Mosaic Natural Stone Shower Pan", "price_per_sqft": 18.0, "raw_description": "Natural river pebble mosaic for shower floor. Tumbled finish. Mesh-backed. Self-draining design. Non-slip natural stone surface."},
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Load Wave-2 catalog rows into enrichment queue")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without inserting")
    parser.add_argument("--limit", type=int, default=150, help="Max rows to insert (default 150)")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is required")
    company_id = os.environ.get("ENRICHMENT_COMPANY_ID")
    if not company_id:
        raise RuntimeError("ENRICHMENT_COMPANY_ID is required")

    rows_to_load = CATALOG_ROWS[: args.limit]
    print(f"Wave-2 queue loader — {len(rows_to_load)} rows (dry_run={args.dry_run})")

    if args.dry_run:
        for r in rows_to_load:
            print(f"  {r['sku']}: {r['product_name'][:60]}")
        return

    conn = psycopg2.connect(db_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Check existing source_row_ids to skip duplicates
    cur.execute("SELECT source_row_id FROM enrichment_queue WHERE company_id = %s", (company_id,))
    existing = {r["source_row_id"] for r in cur.fetchall()}

    inserted = 0
    skipped = 0
    for row in rows_to_load:
        sku = row["sku"]
        if sku in existing:
            skipped += 1
            continue
        cur.execute(
            """
            INSERT INTO enrichment_queue
              (company_id, source_row_id, payload_json, status)
            VALUES (%s, %s, %s, 'pending')
            """,
            (company_id, sku, json.dumps(row)),
        )
        inserted += 1

    conn.commit()
    conn.close()

    print(f"Inserted {inserted} rows, skipped {skipped} duplicates.")
    print(f"Queue ready for batch_runner.py — run with ENRICHMENT_BATCH_SIZE=50 or higher.")


if __name__ == "__main__":
    main()
