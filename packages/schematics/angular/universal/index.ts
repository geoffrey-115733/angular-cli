/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  JsonObject,
  Path,
  basename,
  experimental,
  join,
  normalize,
  parseJson,
  strings,
} from '@angular-devkit/core';
import {
  Rule,
  SchematicContext,
  SchematicsException,
  Tree,
  apply,
  chain,
  mergeWith,
  move,
  template,
  url,
} from '@angular-devkit/schematics';
import {
  NodePackageInstallTask,
} from '@angular-devkit/schematics/tasks';
import * as ts from 'typescript';
import { findNode, getDecoratorMetadata } from '../utility/ast-utils';
import { InsertChange } from '../utility/change';
import { getWorkspace } from '../utility/config';
import { addPackageJsonDependency, getPackageJsonDependency } from '../utility/dependencies';
import { findBootstrapModuleCall, findBootstrapModulePath } from '../utility/ng-ast-utils';
import { getProjectTargets } from '../utility/project-targets';
import { Schema as UniversalOptions } from './schema';


function getWorkspacePath(host: Tree): string {
  const possibleFiles = [ '/angular.json', '/.angular.json' ];

  return possibleFiles.filter(path => host.exists(path))[0];
}

function getClientProject(
  host: Tree, options: UniversalOptions,
): experimental.workspace.WorkspaceProject {
  const workspace = getWorkspace(host);
  const clientProject = workspace.projects[options.clientProject];
  if (!clientProject) {
    throw new SchematicsException(`Client app ${options.clientProject} not found.`);
  }

  return clientProject;
}

function getClientTargets(
  host: Tree,
  options: UniversalOptions,
): experimental.workspace.WorkspaceTool {
  const clientProject = getClientProject(host, options);
  const projectTargets = getProjectTargets(clientProject);

  return projectTargets;
}

function updateConfigFile(options: UniversalOptions, tsConfigDirectory: Path): Rule {
  return (host: Tree) => {
    const workspace = getWorkspace(host);
    if (!workspace.projects[options.clientProject]) {
      throw new SchematicsException(`Client app ${options.clientProject} not found.`);
    }

    const clientProject = workspace.projects[options.clientProject];
    const projectTargets = getProjectTargets(clientProject);

    const builderOptions: JsonObject = {
      outputPath: `dist/${options.clientProject}-server`,
      main: `${clientProject.root}src/main.server.ts`,
      tsConfig: join(tsConfigDirectory, `${options.tsconfigFileName}.json`),
    };
    const serverTarget: JsonObject = {
      builder: '@angular-devkit/build-angular:server',
      options: builderOptions,
    };
    projectTargets.server = serverTarget;

    const workspacePath = getWorkspacePath(host);

    host.overwrite(workspacePath, JSON.stringify(workspace, null, 2));

    return host;
  };
}

function findBrowserModuleImport(host: Tree, modulePath: string): ts.Node {
  const moduleBuffer = host.read(modulePath);
  if (!moduleBuffer) {
    throw new SchematicsException(`Module file (${modulePath}) not found`);
  }
  const moduleFileText = moduleBuffer.toString('utf-8');

  const source = ts.createSourceFile(modulePath, moduleFileText, ts.ScriptTarget.Latest, true);

  const decoratorMetadata = getDecoratorMetadata(source, 'NgModule', '@angular/core')[0];
  const browserModuleNode = findNode(decoratorMetadata, ts.SyntaxKind.Identifier, 'BrowserModule');

  if (browserModuleNode === null) {
    throw new SchematicsException(`Cannot find BrowserModule import in ${modulePath}`);
  }

  return browserModuleNode;
}

function wrapBootstrapCall(options: UniversalOptions): Rule {
  return (host: Tree) => {
    const clientTargets = getClientTargets(host, options);
    const mainPath = normalize('/' + clientTargets.build.options.main);
    let bootstrapCall: ts.Node | null = findBootstrapModuleCall(host, mainPath);
    if (bootstrapCall === null) {
      throw new SchematicsException('Bootstrap module not found.');
    }

    let bootstrapCallExpression: ts.Node | null = null;
    let currentCall = bootstrapCall;
    while (bootstrapCallExpression === null && currentCall.parent) {
      currentCall = currentCall.parent;
      if (currentCall.kind === ts.SyntaxKind.ExpressionStatement) {
        bootstrapCallExpression = currentCall;
      }
    }
    bootstrapCall = currentCall;

    const recorder = host.beginUpdate(mainPath);
    const beforeText = `document.addEventListener('DOMContentLoaded', () => {\n  `;
    const afterText = `\n});`;
    recorder.insertLeft(bootstrapCall.getStart(), beforeText);
    recorder.insertRight(bootstrapCall.getEnd(), afterText);
    host.commitUpdate(recorder);
  };
}

function addServerTransition(options: UniversalOptions): Rule {
  return (host: Tree) => {
    const clientProject = getClientProject(host, options);
    const clientTargets = getClientTargets(host, options);
    const mainPath = normalize('/' + clientTargets.build.options.main);

    const bootstrapModuleRelativePath = findBootstrapModulePath(host, mainPath);
    const bootstrapModulePath = normalize(
      `/${clientProject.root}/src/${bootstrapModuleRelativePath}.ts`);

    const browserModuleImport = findBrowserModuleImport(host, bootstrapModulePath);
    const appId = options.appId;
    const transitionCall = `.withServerTransition({ appId: '${appId}' })`;
    const position = browserModuleImport.pos + browserModuleImport.getFullText().length;
    const transitionCallChange = new InsertChange(
      bootstrapModulePath, position, transitionCall);

    const transitionCallRecorder = host.beginUpdate(bootstrapModulePath);
    transitionCallRecorder.insertLeft(transitionCallChange.pos, transitionCallChange.toAdd);
    host.commitUpdate(transitionCallRecorder);
  };
}

function addDependencies(): Rule {
  return (host: Tree) => {
    const coreDep = getPackageJsonDependency(host, '@angular/core');
    if (coreDep === null) {
      throw new SchematicsException('Could not find version.');
    }
    const platformServerDep = {
      ...coreDep,
      name: '@angular/platform-server',
    };
    addPackageJsonDependency(host, platformServerDep);

    return host;
  };
}

function getTsConfigOutDir(host: Tree, targets: experimental.workspace.WorkspaceTool): string {
  const tsConfigPath = targets.build.options.tsConfig;
  const tsConfigBuffer = host.read(tsConfigPath);
  if (!tsConfigBuffer) {
    throw new SchematicsException(`Could not read ${tsConfigPath}`);
  }
  const tsConfigContent = tsConfigBuffer.toString();
  const tsConfig = parseJson(tsConfigContent);
  if (tsConfig === null || typeof tsConfig !== 'object' || Array.isArray(tsConfig) ||
      tsConfig.compilerOptions === null || typeof tsConfig.compilerOptions !== 'object' ||
      Array.isArray(tsConfig.compilerOptions)) {
    throw new SchematicsException(`Invalid tsconfig - ${tsConfigPath}`);
  }
  const outDir = tsConfig.compilerOptions.outDir;

  return outDir as string;
}

export default function (options: UniversalOptions): Rule {
  return (host: Tree, context: SchematicContext) => {
    const clientProject = getClientProject(host, options);
    if (clientProject.projectType !== 'application') {
      throw new SchematicsException(`Universal requires a project type of "application".`);
    }
    const clientTargets = getClientTargets(host, options);
    const outDir = getTsConfigOutDir(host, clientTargets);
    const tsConfigExtends = basename(clientTargets.build.options.tsConfig);
    const rootInSrc = clientProject.root === '';
    const tsConfigDirectory = join(normalize(clientProject.root), rootInSrc ? 'src' : '');

    if (!options.skipInstall) {
      context.addTask(new NodePackageInstallTask());
    }

    const templateSource = apply(url('./files/src'), [
      template({
        ...strings,
        ...options as object,
        stripTsExtension: (s: string) => s.replace(/\.ts$/, ''),
      }),
      move(join(normalize(clientProject.root), 'src')),
    ]);

    const rootSource = apply(url('./files/root'), [
      template({
        ...strings,
        ...options as object,
        stripTsExtension: (s: string) => s.replace(/\.ts$/, ''),
        outDir,
        tsConfigExtends,
        rootInSrc,
      }),
      move(tsConfigDirectory),
    ]);

    return chain([
      mergeWith(templateSource),
      mergeWith(rootSource),
      addDependencies(),
      updateConfigFile(options, tsConfigDirectory),
      wrapBootstrapCall(options),
      addServerTransition(options),
    ]);
  };
}
