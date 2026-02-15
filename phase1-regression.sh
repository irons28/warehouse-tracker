#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
TS="$(date +%s)"
PALLET_ID="P1-${TS}"
FROM_LOC="A1-L1"
TO_LOC="A1-L2"

echo "Running Phase 1 + Phase 2 regression against ${BASE_URL}"
AUTH_TOKEN=""

LOGIN_RESP="$(curl -sS -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  --data '{"username":"admin","password":"admin123!"}')"
AUTH_TOKEN="$(echo "${LOGIN_RESP}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "${AUTH_TOKEN}" ]; then
  echo "Auth failed. Ensure bootstrap credentials are valid (admin / admin123!)."
  exit 1
fi

post_json() {
  local path="$1"
  local payload="$2"
  curl -sS -X POST "${BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    --data "$payload"
}

delete_json() {
  local path="$1"
  local payload="$2"
  curl -sS -X DELETE "${BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    --data "$payload"
}

echo "1) Check-in idempotency"
CHECKIN_KEY="reg-checkin-${TS}"
CHECKIN_PAYLOAD="{\"id\":\"${PALLET_ID}\",\"customer_name\":\"REG_TEST\",\"product_id\":\"SKU-REG\",\"pallet_quantity\":1,\"product_quantity\":10,\"location\":\"${FROM_LOC}\",\"scanned_by\":\"Regression\",\"actor_id\":\"regression\",\"client_session_id\":\"regression\",\"idempotency_key\":\"${CHECKIN_KEY}\"}"
R1="$(post_json "/api/pallets" "${CHECKIN_PAYLOAD}")"
R2="$(post_json "/api/pallets" "${CHECKIN_PAYLOAD}")"
echo "${R1}" | grep -q "\"id\":\"${PALLET_ID}\""
echo "${R2}" | grep -q "\"deduped\":true"

echo "2) Move flow + idempotency"
MOVE_KEY="reg-move-${TS}"
MOVE_PAYLOAD="{\"to_location\":\"${TO_LOC}\",\"scanned_by\":\"Regression\",\"actor_id\":\"regression\",\"client_session_id\":\"regression\",\"idempotency_key\":\"${MOVE_KEY}\"}"
R3="$(post_json "/api/pallets/${PALLET_ID}/move" "${MOVE_PAYLOAD}")"
R4="$(post_json "/api/pallets/${PALLET_ID}/move" "${MOVE_PAYLOAD}")"
echo "${R3}" | grep -q "\"to_location\":\"${TO_LOC}\""
echo "${R4}" | grep -q "\"deduped\":true"

echo "3) Unit removal + idempotency"
UNITS_KEY="reg-units-${TS}"
UNITS_PAYLOAD="{\"units_to_remove\":1,\"scanned_by\":\"Regression\",\"actor_id\":\"regression\",\"client_session_id\":\"regression\",\"idempotency_key\":\"${UNITS_KEY}\"}"
R5="$(post_json "/api/pallets/${PALLET_ID}/remove-units" "${UNITS_PAYLOAD}")"
R6="$(post_json "/api/pallets/${PALLET_ID}/remove-units" "${UNITS_PAYLOAD}")"
echo "${R5}" | grep -q "\"units_removed\":1"
echo "${R6}" | grep -q "\"deduped\":true"

echo "4) Check-out + idempotency"
CHECKOUT_KEY="reg-checkout-${TS}"
CHECKOUT_PAYLOAD="{\"scanned_by\":\"Regression\",\"actor_id\":\"regression\",\"client_session_id\":\"regression\",\"idempotency_key\":\"${CHECKOUT_KEY}\"}"
R7="$(delete_json "/api/pallets/${PALLET_ID}" "${CHECKOUT_PAYLOAD}")"
R8="$(delete_json "/api/pallets/${PALLET_ID}" "${CHECKOUT_PAYLOAD}")"
echo "${R7}" | grep -q "checked out successfully"
echo "${R8}" | grep -q "\"deduped\":true"

echo "5) Phase 2 invoice/payment sanity"
INV_CUSTOMER="REG_FINANCE_${TS}"
RATE_PAYLOAD="{\"customer_name\":\"${INV_CUSTOMER}\",\"rate_per_pallet_week\":10,\"handling_fee_flat\":1,\"handling_fee_per_pallet\":0.5,\"payment_terms_days\":7,\"currency\":\"GBP\"}"
post_json "/api/rates" "${RATE_PAYLOAD}" > /dev/null

INV_PAYLOAD="{\"customer_name\":\"${INV_CUSTOMER}\",\"start_date\":\"2026-01-01\",\"end_date\":\"2026-01-07\",\"rate_per_pallet_week\":10,\"handling_fee_flat\":1,\"handling_fee_per_pallet\":0.5,\"payment_terms_days\":7}"
INV_RESP="$(post_json "/api/invoices/generate" "${INV_PAYLOAD}")"
INV_ID="$(echo "${INV_RESP}" | sed -n 's/.*\"invoice_id\":\([0-9][0-9]*\).*/\1/p')"
test -n "${INV_ID}"

PAY_PAYLOAD="{\"amount\":1.50,\"note\":\"regression payment\"}"
PAY_RESP="$(post_json "/api/invoices/${INV_ID}/payments" "${PAY_PAYLOAD}")"
echo "${PAY_RESP}" | grep -q "\"ok\":true"

AGING_RESP="$(curl -sS "${BASE_URL}/api/invoices/aging" -H "Authorization: Bearer ${AUTH_TOKEN}")"
echo "${AGING_RESP}" | grep -q "\"ok\":true"

echo "Phase 1 + Phase 2 regression checks passed."
