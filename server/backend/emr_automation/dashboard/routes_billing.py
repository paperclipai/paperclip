"""Billing routes for Toca Ficha Dr. cloud API."""
import os
from flask import Blueprint, request, jsonify, g
from emr_automation.auth import require_auth
from emr_automation.billing import create_checkout_session, create_portal_session, handle_webhook, get_subscription

billing_bp = Blueprint("billing", __name__)


@billing_bp.route("/billing/create-checkout", methods=["POST"])
@require_auth
def billing_create_checkout():
    """Create a Stripe Checkout session."""
    data = request.get_json()
    plan = data.get("plan", "pro") if data else "pro"
    success_url = data.get("success_url", "https://tocafichadr.com.br/success") if data else "https://tocafichadr.com.br/success"
    cancel_url = data.get("cancel_url", "https://tocafichadr.com.br/cancel") if data else "https://tocafichadr.com.br/cancel"

    result = create_checkout_session(g.user_id, plan, success_url, cancel_url)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@billing_bp.route("/billing/portal")
@require_auth
def billing_portal():
    """Create a Stripe Customer Portal session.

    The portal lets users manage subscriptions, update payment methods,
    and view invoices. Returns a redirect URL for the Stripe-hosted portal.
    """
    return_url = request.args.get("return_url", "https://tocafichadr.com.br/")

    result = create_portal_session(g.user_id, return_url)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@billing_bp.route("/billing/webhook", methods=["POST"])
def billing_webhook():
    """Handle Stripe webhook events.

    Notes:
    - Uses raw request body (bytes) for Stripe signature verification.
    - Returns 200 for all events (including unknown) to prevent Stripe retries.
    - No auth decorator — Stripe authenticates via webhook signature.
    """
    payload = request.get_data()  # raw bytes required for signature verification
    sig_header = request.headers.get("Stripe-Signature", "")
    result = handle_webhook(payload, sig_header)
    if isinstance(result, tuple):
        return jsonify(result[0]), result[1]
    return jsonify(result), 200


@billing_bp.route("/billing/subscription")
@require_auth
def billing_subscription():
    """Get current subscription status and usage."""
    result = get_subscription(g.user_id)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)
