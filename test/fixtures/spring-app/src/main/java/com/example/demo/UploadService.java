package com.example.demo;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class UploadService {

    @Value("${app.upload-dir}")
    private String uploadDir;

    // missing from application.properties: app.mail.smtp-host
    @Value("${app.mail.smtp-host}")
    private String smtpHost;

    // has default value — still reported, but the report shows it
    @Value("${app.cache.ttl-seconds:3600}")
    private long cacheTtl;

    private final String dbPassword;

    public UploadService(@Value("${DB_PASSWORD}") String dbPassword) {
        this.dbPassword = dbPassword;
    }

    // relaxed binding: app.feature-legacy.enabled vs app.featureLegacy.enabled
    @Value("${app.featureLegacy.enabled}")
    private boolean featureLegacyEnabled;

    public String describe() {
        return uploadDir + smtpHost + dbPassword + featureLegacyEnabled + cacheTtl;
    }
}
