#=========================================================================#
# ARU PriceMark - HestiaCP Nginx template (HTTP)                          #
# Proxies pricemark.aruraharaja.co.id to Node.js on 127.0.0.1:3300       #
#=========================================================================#

server {
    listen %ip%:%proxy_port%;
    server_name %domain_idn% %alias_idn%;

    error_log /var/log/%web_system%/domains/%domain%.error.log error;
    access_log /var/log/%web_system%/domains/%domain%.log combined;
    access_log /var/log/%web_system%/domains/%domain%.bytes bytes;

    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

    # Keep Let's Encrypt HTTP-01 renewal reachable from Hestia docroot.
    location ^~ /.well-known/acme-challenge/ {
        root %docroot%;
        default_type "text/plain";
        try_files $uri =404;
    }

    location ~ /\.(?!well-known/) {
        deny all;
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_cache_bypass $http_upgrade;

        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        client_max_body_size 25m;
    }

    location /error/ {
        alias %home%/%user%/web/%domain%/document_errors/;
    }

    include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
