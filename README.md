## Structure
```
cirron-cli/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── bin/
│   └── cirron
├── scripts/
│   ├── install.sh
│   └── release.js
├── src/
│   ├── commands/
│   │   ├── auth.ts
│   │   ├── build.ts
│   │   ├── deploy.ts
│   │   └── init.ts
│   ├── utils/
│   │   ├── api.ts
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── types/
│   │   └── index.ts
│   └── index.ts
├── templates/
│   ├── nextjs/
│   └── react/
├── tests/
│   └── commands/
├── .gitignore
├── .npmignore
├── package.json
├── tsconfig.json
├── jest.config.js
├── README.md
└── LICENSE
```