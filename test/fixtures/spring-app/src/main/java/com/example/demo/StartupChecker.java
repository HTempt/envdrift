package com.example.demo;

import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public class StartupChecker {

    private final String region;

    public StartupChecker(Environment environment) {
        // missing from application.properties: app.region
        this.region = environment.getProperty("app.region");
    }

    public String getRegion() {
        return region;
    }
}
