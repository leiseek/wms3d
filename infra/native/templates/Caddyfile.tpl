# wms3d 反向代理（08 §5.3）。由 infra/native/install.sh 渲染：@PREFIX@ @API_PORT@ @SITE@ @TLS@ @HSTS@
{
	admin off
	@GLOBAL@
}

@SITE@ {
	@TLS@
	encode zstd gzip
	header {
		@HSTS@
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
		-Server
	}
	# SSE：不缓冲（flush_interval -1），否则事件会被攒批
	handle /api/v1/events* {
		reverse_proxy 127.0.0.1:@API_PORT@ {
			flush_interval -1
		}
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:@API_PORT@
	}
	# APK 分发（08 §7）：/downloads/app.apk
	handle_path /downloads/* {
		root * @PREFIX@/downloads
		file_server
	}
	# 管理后台 SPA
	handle {
		root * @PREFIX@/admin
		try_files {path} /index.html
		file_server
	}
	log {
		output file @PREFIX@/logs/caddy-access.log {
			roll_size 50MiB
			roll_keep 10
		}
	}
}
