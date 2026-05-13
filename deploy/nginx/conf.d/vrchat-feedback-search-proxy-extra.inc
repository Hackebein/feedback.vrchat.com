# Response hardening for proxied OpenSearch endpoints.
# Public results are dynamic and small; never let intermediaries cache them.
add_header Cache-Control "no-store" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
