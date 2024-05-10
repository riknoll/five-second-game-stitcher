/// <reference lib="dom" />

import * as fs from "fs";
import * as crypto from "crypto";


const PROJECT_NAME = "Five Second Games Redux";

interface ScriptMeta {
    kind: "script";
    id: string;
    shortid: string;
    time: number;
    name: string;
    description: string;
    target: string;
    editor: string;
    meta: {
        versions: {
            branch: string;
            tag: string;
            commits: string;
            target: string;
            pxt: string;
        };
        blocksHeight: number;
        blocksWidth: number;
    };
    thumb: boolean;
}

interface Config {
    dependencies: {[index: string]: string};
    files: string[];
    palette?: string[];
}

interface GameInfo {
    url: string
    meta: ScriptMeta;
    text: {[index: string]: string};
    config: Config;
    author: string;
}

interface TileInfo {
    oldId: string;
    newId: string;
    data: any;
}

interface Script {
    main: string;
    jresEntries: {[index: string]: any};
    jresTs: string;
    kinds: string[];
    statusBarKinds: string[];
}


function fetchAll(): Promise<GameInfo[]> {
    const prefix = "https://arcade.makecode.com/";
    const backendEndpoint = "https://makecode.com/api";
    const games = JSON.parse(fs.readFileSync("./games.json", "utf8"));

    return Promise.all(games.games.map(async entry => {
        const id = entry.url.substr(prefix.length);

        const metadata = await fetch(backendEndpoint + "/" + id);
        const meta = await metadata.json() as ScriptMeta;

        const textdata = await fetch(backendEndpoint + "/" + id + "/text");
        const text = await textdata.json() as {[index: string]: string};

        return {
            meta,
            text,
            config: JSON.parse(text["pxt.json"]),
            ...entry
        }
    }))
}

function getDependencies(games: GameInfo[]) {
    const allDependencies: {[index: string]: string} = {
        "Color Fading": "github:jwunderl/pxt-color#v0.2.3"
    };

    for (const game of games) {
        for (const dep of Object.keys(game.config.dependencies)) {
            if (dep === "arcade-five-second-game-lib") continue;
            if (!allDependencies[dep]) {
                allDependencies[dep] = game.config.dependencies[dep]
            }
        }
    }

    return allDependencies;
}

function indent(text: string, spaces: number) {
    let indent = "";
    for (let i = 0; i < spaces; i++) indent += " ";
    return text.split("\n").map(l => l ? indent + l : l).join("\n");
}

function processScript(game: GameInfo, index: number): Script {
    let concatenated = "";
    let main = "";
    let tileHelpers = ""
    const kinds: string[] = [];
    const statusBarKinds: string[] = [];
    let jresEntries: {[index: string]: any} = {};

    let declarations = "";
    let functions = "";

    let tileTs = "";

    let tileJRES: any;

    let paletteCode = ""
    if (game.config.palette) {
        for (let i = 0; i < game.config.palette.length; i++) {
            paletteCode += `color.setColor(${i}, color.parseColorString("${game.config.palette[i]}"));\n`
        }
    }

    if (game.text["tilemap.g.jres"]) {
        tileJRES = JSON.parse(game.text["tilemap.g.jres"])
    }

    for (const file of game.config.files) {
        if (!file.endsWith(".ts")) continue;

        let text = game.text[file];
        if (file === "images.g.ts") {
            text = text.replace(/namespace\s+myImages\s+/, "");
        }
        else if (file === "tilemap.g.ts") {
            const lines = text.split("\n");
            const tileNames: TileInfo[] = [];
            let out = "";

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = /export\s+const\s+([^\s]+)\s+/.exec(line);

                if (match) {
                    const id = match[1];

                    const newId = `game${index}_${id}`;

                    out += `    export const ${newId} = image.ofBuffer(hex\`\`);\n`;

                    tileNames.push({
                        oldId: id,
                        newId,
                        data: tileJRES[id],
                    });
                }
                else if (line.indexOf("_registerFactory") !== -1) {
                    text = lines.slice(i).filter(l => !(l.startsWith("}") || l.startsWith("//"))).join("\n");
                    break;
                }
                else {
                    out += line + "\n"
                }
            }

            tileTs = out + "\n}\n";

            for (const tile of tileNames) {
                text = text.replaceAll("myTiles." + tile.oldId, "myTiles." + tile.newId);
                text = text.replaceAll("return " + tile.oldId, "return myTiles." + tile.newId);
                jresEntries[tile.newId] = tile.data;
            }

            tileHelpers += text + "\n";
            continue;
        }
        else {
            text = text.replace(
                /namespace SpriteKind {[^}]*}/gm,
                function (substring) {
                    const lines = substring.split("\n");
                    for (const line of lines) {
                        const match = /export\s+const\s+([^\s]+)\s+/.exec(line);
                        if (match) kinds.push(match[1]);
                    }
                    return "";
                }
            );

            text = text.replace(
                /namespace StatusBarKind {[^}]*}/gm,
                function (substring) {
                    const lines = substring.split("\n");
                    for (const line of lines) {
                        const match = /export\s+const\s+([^\s]+)\s+/.exec(line);
                        if (match) statusBarKinds.push(match[1]);
                    }
                    return "";
                }
            );

            let body = ""

            for (const line of text.split("\n")) {
                const match = /^(\s*let\s+([^\s:]+)\s*(:\s*[^=]+)?\s*=)(.*)/.exec(line);

                if (match) {
                    if (match[3]) {
                        declarations += `let ${match[2]}${match[3]};\n`
                    }
                    else {
                        // infer type
                        const value = match[4].replace(";", "").trim();
                        let type = "any"
                        if (!Number.isNaN(parseFloat(value))) {
                            type = "number"
                        }
                        else if (value === "false" || value === "true") {
                            type = "boolean"
                        }
                        else if (/^"[^"]*"$/.test(value)) {
                            type = "string";
                        }
                        else if (/^\[/.test(value)) {
                            type = "any[]"
                        }
                        declarations += `let ${match[2]}: ${type};\n`
                    }
                    body += `${match[2]} = ${line.substring(match[1].length)}\n`
                }
                else {
                    body += line + "\n"
                }
            }

            let match: RegExpExecArray;
            while (match = /^\s*function\s+([^\s\(\)]+)\s*(\([^\)]*\))\s*(?:\:[^\{]*)?{/gm.exec(body)) {
                let braceCount = 0;
                let bodyStart = -1;
                let current = match.index;

                while (true) {
                    // console.log(body.charAt(current))
                    if (body.charAt(current) === "{") {
                        if (bodyStart === -1) bodyStart = current;
                        braceCount++;
                    }
                    else if (body.charAt(current) === "}") {
                        braceCount--;
                    }

                    current++;

                    if (braceCount === 0 && bodyStart !== -1) break;
                }

                const funcBody = body.substring(bodyStart, current);

                const lambda = `const ${match[1]} = ${match[2]} => ${funcBody}\n`
                functions += lambda

                body = body.substring(0, match.index) + body.substring(current)
            }

            text = body;
        }


        if (file === "main.ts") {
            main = text;
        }
        else {
            concatenated += text + "\n";
        }
    }

    concatenated = tileHelpers + declarations + functions + paletteCode + concatenated + main;
    concatenated = `function game${index}() {\n${indent(concatenated, 4)}\n}\n`;
    concatenated = `// written by ${game.author}\n// original link ${game.url}\n${concatenated}`

    return {
        main: concatenated,
        kinds,
        statusBarKinds,
        jresEntries,
        jresTs: tileTs
    }
}

const apiRoot = "https://arcade.makecode.com";

export async function shareProjectAsync(files: {[index: string]: string}) {
    const req = createShareLinkRequestAsync(files);

    const res = await fetch(apiRoot + "/api/scripts", {
        body: new Blob([JSON.stringify(req)], {type: "application/json"}),
        method: "POST"
    });

    const data = await res.json();

    console.log(data)
    return apiRoot + "/" + data.shortid
}

function createShareLinkRequestAsync(files: {[index: string]: string}) {
    const header = {
        "name": PROJECT_NAME,
        "meta": {
            "versions": {
                "branch": "v1.12.30",
                "tag": "v1.12.30",
                "commits": "https://github.com/microsoft/pxt-arcade/commits/33228b1cc7e1bea3f728c26a6047bdef35fd2c09",
                "target": "1.12.30",
                "pxt": "8.5.41"
            }
        },
        "editor": "tsprj",
        "pubId": undefined,
        "pubCurrent": false,
        "target": "arcade",
        "targetVersion": "1.12.30",
        "id": crypto.randomUUID(),
        "recentUse": Date.now(),
        "modificationTime": Date.now(),
        "path": PROJECT_NAME,
        "saveId": {},
        "githubCurrent": false,
        "pubVersions": []
    }

    return {
        id: header.id,
        name: header.name,
        target: header.target,
        targetVersion: header.targetVersion,
        description: `The combined games from the five-second mini game jam!`,
        editor: header.editor,
        header: JSON.stringify(header),
        text: JSON.stringify(files),
        meta: header.meta
    }
}

async function main() {
    const libTS = fs.readFileSync("./lib.ts", "utf8")
    const games = await fetchAll();
    const deps = getDependencies(games);

    let mainTS = "";
    let jresTS = "";
    let jres: any = {
        "*": {
            "mimeType": "image/x-mkcd-f4",
            "dataEncoding": "base64",
            "namespace": "myTiles"
        }
    }

    const kinds: string[] = [];
    const statusKinds: string[] = [];

    const text = {
    };

    const config = {
        "name": PROJECT_NAME,
        "description": "",
        "dependencies": deps,
        "files": [
            "tilemap.jres",
            "tilemap.ts",
            "kinds.ts",
            "lib.ts"
        ],
        "preferredEditor": "tsprj"
    };

    games.forEach((g, i) => {
        const s = processScript(g, i);

        jres = {
            ...jres,
            ...s.jresEntries
        };

        const filename = `game${i}.ts`;
        config.files.push(filename);
        text[filename] = s.main;

        jresTS += s.jresTs;

        for (const kind of s.kinds) {
            if (kinds.indexOf(kind) === -1) kinds.push(kind)
        }
        for (const kind of s.statusBarKinds) {
            if (statusKinds.indexOf(kind) === -1) statusKinds.push(kind)
        }
        mainTS += `GameJam.registerGame("${g.author}", game${i});\n`;
    })

    mainTS += `GameJam.init();\n`;

    let kindsTS = `namespace SpriteKind {\n`
    kindsTS += kinds.map(kind => `    export const ${kind} = SpriteKind.create();`).join("\n")
    kindsTS += "\n}\n";
    kindsTS += `namespace StatusBarKind {\n`
    kindsTS += statusKinds.map(kind => `    export const ${kind} = StatusBarKind.create();`).join("\n")
    kindsTS += "\n}\n";

    config.files.push("main.ts");

    text["pxt.json"] = JSON.stringify(config, null, 4);
    text["tilemap.jres"] = JSON.stringify(jres);
    text["tilemap.ts"] = jresTS;
    text["kinds.ts"] = kindsTS;
    text["main.ts"] = mainTS;
    text["lib.ts"] = libTS;

    console.log(await shareProjectAsync(text));
}

main();