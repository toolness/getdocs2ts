import * as j from 'jscodeshift';
import { Path, Spec, MethodSpec, PropertySpec, SpecKind } from './types';
import invariant from './invariant';
import { closestViaParentPath } from './traverse';
import { parse, TypeNode, FunctionParameterTypeNode } from './getdocs/parser';

export function extractMethod(commentPath: Path): MethodSpec | undefined {
  const methodDefinitionPath = closestViaParentPath(commentPath, j.MethodDefinition);
  if (methodDefinitionPath) {
    const classDeclarationPath = closestViaParentPath(methodDefinitionPath, j.ClassDeclaration);
    invariant(!!classDeclarationPath, 'Expected method to be in a class declaration.');
    const spec = stripCommentSpecPrefix(commentPath.value.value);

    const functionDefinition = methodDefinitionPath.value.value;
    const paramNames = functionDefinition.params.map(node => {
      switch (node.type) {
        case 'Identifier': // foo(bar) {}
          return node.name;
        case 'AssignmentPattern': // foo(bar = 1) {}
          return node.left.name;
      }
    });

    return {
      kind: SpecKind.Method,
      name: methodDefinitionPath.value.key.name,
      spec,
      parent: classDeclarationPath.value.id.name,
      paramNames,
    }
  }
}

export function extractProperty(commentPath: Path): PropertySpec | undefined {
  const classDeclaration = closestViaParentPath(commentPath, j.ClassDeclaration);
  const methodDefinition = closestViaParentPath(commentPath, j.MethodDefinition);
  const expressionStatement = closestViaParentPath(commentPath, j.ExpressionStatement);
  if (classDeclaration && methodDefinition && expressionStatement) {
    const propertyName = j(expressionStatement)
      .find(j.ThisExpression)
      .paths()[0]
      .parent.value // MemberExpression (this.foo)
      .property.name; // foo

    const spec = stripCommentSpecPrefix(commentPath.value.value);
    return {
      kind: SpecKind.Property,
      name: propertyName,
      spec,
      parent: classDeclaration.value.id.name
    };
  }
}

export interface ClassTypeNode {
  kind: 'Class';
  constructorParameters?: FunctionParameterTypeNode[];
}

export interface InterfaceTypeNode {
  kind: 'Interface';
}

export type ProgramTypeNode = ClassTypeNode | InterfaceTypeNode | TypeNode;

/**
 * Strip off the ' :: ' or ' : ' prefix.
 */
function stripCommentSpecPrefix(prefixedSpec: string): string {
  const rawCommentSpec = prefixedSpec;
  const [matched, prefix, spec] = rawCommentSpec.match(/^( ::? )?(.*)$/);
  invariant(!!matched, `Invalid comment spec syntax '${prefixedSpec}'.`)
  return spec;
}

export interface Declaration {
  name?: string;
  typeSpec?: string;
  type?: ProgramTypeNode;
  properties?: Declaration[];
}

export function extract(source: string): Declaration[] {
  const declarations = [];
  const nodeToDeclarationMap = [] as { path: any; declaration: Declaration }[];
  const program = j(source);

  interface DeclarationLine {
    kind: 'DeclarationLine';
    identifier?: string;
    indent: number;
    typeSpec: string;
  }

  interface DocumentationLine {
    kind: 'DocumentationLine';
    text: string;
    indent: number;
  }

  interface EmptyLine {
    kind: 'EmptyLine';
    indent: number;
  }

  type Line = DeclarationLine | DocumentationLine | EmptyLine;

  gatherComments().forEach(parseComments);
  return declarations;

  function parseLine(line: string): Line {
    let result;

    // Test for a DeclarationLine.
    result = line.match(/^( +)([a-zA-Z\._]*)(::?-? *)(.*)$/);
    if (result) {
      const [_, indent, identifier, colons, spec] = result;
      const line: DeclarationLine = {
        kind: 'DeclarationLine',
        indent: indent.length,
        typeSpec: spec
      };
      if (identifier) {
        line.identifier = identifier;
      }
      return line;
    }

    // Test for a DocumentationLine.
    result = line.match(/^( +)(.+)$/);
    if (result) {
      const [_, indent, text] = result;
      return {
        kind: 'DocumentationLine',
        indent: indent.length,
        text
      }
    }

    // Test for an EmptyLine.
    result = line.match(/^( *)$/);
    if (result) {
      const [_, indent] = result;
      return {
        kind: 'EmptyLine',
        indent
      };
    }
    throw new Error(`Unknown syntax in comment: ${line}`);
  }

  // function parseComments(comments: CommentBlock) {
  //   const { lines, associatedNodePath } = comments;
  //   let collectedLines = [];
  //   let remainingLines = lines.length;
  //   let lastLineNumber = lines[lines.length - 1].loc.start.line;
  //   while (remainingLines) {
  //     while (lines[remainingLines - 1])
  //   }
  //   for (let i = lines.length - 1; i >= 0; i--) {
  //     const line = parseLine(lines[i]);

  //   }
  // }

  function parseComments(comments: CommentBlock) {
    // A comment block ignores empty lines between comments, which isn't what we want.
    //
    // For example there might be a comment block:
    //
    //     // Foo:: interface
    //     //
    //     //   foo:: number
    //
    //     // ::-
    //     class Bar {
    //       // bar:: string;
    //     }
    //
    // In this case we want Foo and Bar to be considered separately, and we definitely don't
    // want Foo associated with the class.
    const lines = comments.lines.map(parseLine);
    const end = lines.length;
    let pos = 0;
    let line = lines[pos];

    while (line) {
      switch (line.kind) {
        case 'DeclarationLine':
          const declarationLine = line;
          const declaration = parseDeclaration();
          let parentDeclaration = findParentDeclaration(comments.associatedNodePath);
          if (!parentDeclaration) {
            const classDeclarations = j(comments.associatedNodePath).closest(j.ClassDeclaration).paths();
            if (classDeclarations.length === 1) {
              const classDeclaration = classDeclarations[0];
              parentDeclaration = {
                name: nameFromPath(classDeclaration),
                type: typeFromPath(classDeclaration),
              };
              declarations.push(parentDeclaration);
              nodeToDeclarationMap.push({ path: classDeclaration, declaration: parentDeclaration });
            }
          }

          if (parentDeclaration) {
            if (declaration.type.kind === 'Function' && declaration.name === 'constructor' && parentDeclaration.type.kind === 'Class') {
              parentDeclaration.type.constructorParameters = declaration.type.parameters;
            } else {
              parentDeclaration.properties = parentDeclaration.properties || [];
              parentDeclaration.properties.push(declaration);
            }
          } else {
            declarations.push(declaration);
          }
          if (comments.associatedNodePath.value.type !== 'Program') {
            nodeToDeclarationMap.push({
              path: comments.associatedNodePath,
              declaration
            });
          }
          break;
        case 'DocumentationLine':
        case 'EmptyLine':
          nextLine();
          break;
      }
    }

    function findParentDeclaration(p: any): Declaration | undefined {
      for (const { path, declaration } of nodeToDeclarationMap) {
        let parent = p;
        while (parent = parent.parentPath) {
          if (parent === path) {
            return declaration;
          }
        }
      }
    }

    function nameFromPath(path: any): string {
      const node = path.node;
      switch (node.type) {
        case 'ClassDeclaration':
        case 'FunctionDeclaration':
          return node.id.name;
        case 'MethodDefinition':
          return node.key.name;
        case 'ExpressionStatement':
          return j(node)
            .find(j.ThisExpression)
            .paths()[0]
            .parent.value // MemberExpression (this.foo)
            .property.name; // foo
        case 'VariableDeclaration':
          if (node.declarations.length !== 1) {
            throw new Error('Unable to deal with a multi-variable declaration.');
          }
          return node.declarations[0].id.name;
        default:
          throw new Error(`Unable to derive declaration name from a '${node.type}'.`);
      }
    }

    function typeFromPath(path: any): ProgramTypeNode {
      switch (path.value.type) {
        case 'ClassDeclaration':
          return { kind: 'Class' };
        case 'FunctionDeclaration':
          return {
            kind: 'Function',
            parameters: []
          }
        case 'VariableDeclaration':
          return { kind: 'Any' };
        default:
          throw new Error(`Unable to derive declaration type from a '${path.value.type}'.`);
      }
    }

    function parseDeclaration(): Declaration {
      const { typeSpec, identifier, indent } = line as DeclarationLine;
      const declaration: Declaration = {}

      // A declaration without a name implicitly applies to the next
      // program element. We derive the name based on that.
      declaration.name = identifier || nameFromPath(comments.associatedNodePath);
      if (typeSpec) {
        declaration.typeSpec = typeSpec
        declaration.type = typeSpec === 'interface'
          ? { kind: 'Interface' }
          : parse(declaration.typeSpec);
      } else {
        declaration.type = typeFromPath(comments.associatedNodePath);
      }

      if (comments.associatedNodePath.value.type === 'MethodDefinition') {
        if (declaration.type.kind === 'Function') {
          const functionDefinition = comments.associatedNodePath.value.value;
          const paramNames = functionDefinition.params.map(node => {
            switch (node.type) {
              case 'Identifier': // foo(bar) {}
                return node.name;
              case 'AssignmentPattern': // foo(bar = 1) {}
                return node.left.name;
            }
          });
          for (let i = 0; i < declaration.type.parameters.length; i++) {
            if (!declaration.type.parameters[i].name) {
              declaration.type.parameters[i].name = paramNames[i];
            }
          }
        }
      }

      skipUntil('EmptyLine');

      loop: while (line) {
        switch (line.kind) {
          case 'DocumentationLine':
            skipUntil('EmptyLine');
            break;
          case 'EmptyLine':
            nextLine();
            break;
          case 'DeclarationLine':
            if (line.indent > indent) {
              const properties = parseProperties();
              if (properties.length) {
                declaration.properties = properties;
              }
            }
            break loop;
        }
      }

      return declaration;
    }

    function parseProperties(): Declaration[] {
      const { indent } = line;
      const members = [];

      loop: while (line) {
        switch (line.kind) {
          case 'EmptyLine':
            nextLine();
            break;
          case 'DocumentationLine':
            if (line.indent >= indent) {
              throw new Error('Unexpected documentation line.');
            }
          case 'DeclarationLine':
            if (line.indent === indent) {
              members.push(parseDeclaration());
              break;
            } else if (line.indent < indent) {
              break loop;
            }
        }
      }

      return members;
    }

    function skipUntil(kind: string) {
      while (line && line.kind !== kind) {
        nextLine();
      }
    }

    function nextLine() {
      line = pos < end
        ? lines[++pos]
        : undefined;
      return line;
    }
  }

  /**
   * Extract groups of comments and their proceeding program element from a
   * program.
   *
   * This organisation of comments is convenient to work on for extracting
   * getdocs information.
   */
  function gatherComments(): CommentBlock[] {
    const commentsPaths = [];

    // The psuedo "comments" path only seems accessible via .parentPath on a
    // Comment path, so we're left with an inefficient algorithm here of
    // building a unique array of each Comment's .parentPath
    program.find(j.Comment).paths().forEach(commentPath => {
      const commentsPath = commentPath.parentPath;
      const lastCommentsPath = commentsPaths[commentsPaths.length - 1];
      if (commentsPath !== lastCommentsPath) {
        commentsPaths.push(commentsPath);
      }
    });

    const lineGroups = [];

    function pushLine(line: any) {
      lineGroups[lineGroups.length - 1].lines.push(line);
    }

    function lastLineLocStartLine(): number {
      const lines = lineGroups[lineGroups.length - 1].lines;
      return lines[lines.length - 1].loc.start.line;
    }

    function startEmptyBlock(associatedNodePath: any) {
      lineGroups.push({ lines: [], associatedNodePath });
    }

    commentsPaths.reverse().forEach(commentsPath => {
      const lines = j(commentsPath).find(j.Comment).nodes();
      debugger;
      startEmptyBlock(commentsPath.parent);
      pushLine(lines[0]);

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (lastLineLocStartLine() !== line.loc.start.line - 1) {
          startEmptyBlock(commentsPath.parent);
        }
        pushLine(line);
      }

      lineGroups[lineGroups.length - 1].associatedNodePath = commentsPath.parentPath;
    });

    return lineGroups.map((lineGroup, index) => {
      const { lines, associatedNodePath } = lineGroup;
      return {
        lines: lines.map(line => line.value),
        associatedNodePath
      };
    });
  }

  interface CommentBlock {
    lines: string[];
    associatedNodePath?: any;
  }
}

