/*
 * Compiler passes.
 *
 * Each pass is a function that is passed the AST. It can perform checks on it
 * or modify it as needed. If the pass encounters a semantic error, it throws
 * |PEG.GrammarError|.
 */
PEG.compiler.passes = {
  /* Checks that all referenced rules exist. */
  reportMissingRules: function(ast) {
    function nop() {}

    function checkExpression(node) { check(node.expression); }

    function checkSubnodes(propertyName) {
      return function(node) { each(node[propertyName], check); };
    }

    var check = buildNodeVisitor({
      grammar:
        function(node) {
          for (var name in node.rules) {
            check(node.rules[name]);
          }
        },

      rule:         checkExpression,
      choice:       checkSubnodes("alternatives"),
      sequence:     checkSubnodes("elements"),
      labeled:      checkExpression,
      simple_and:   checkExpression,
      simple_not:   checkExpression,
      semantic_and: nop,
      semantic_not: nop,
      optional:     checkExpression,
      zero_or_more: checkExpression,
      one_or_more:  checkExpression,
      action:       checkExpression,

      rule_ref:
        function(node) {
          if (ast.rules[node.name] === undefined) {
            throw new PEG.GrammarError(
              "Referenced rule \"" + node.name + "\" does not exist."
            );
          }
        },

      literal:      nop,
      any:          nop,
      "class":      nop
    });

    check(ast);
  },

  /* Checks that no left recursion is present. */
  reportLeftRecursion: function(ast) {
    function nop() {}

    function checkExpression(node, appliedRules) {
      check(node.expression, appliedRules);
    }

    var check = buildNodeVisitor({
      grammar:
        function(node, appliedRules) {
          for (var name in node.rules) {
            check(node.rules[name], appliedRules);
          }
        },

      rule:
        function(node, appliedRules) {
          check(node.expression, appliedRules.concat(node.name));
        },

      choice:
        function(node, appliedRules) {
          each(node.alternatives, function(alternative) {
            check(alternative, appliedRules);
          });
        },

      sequence:
        function(node, appliedRules) {
          if (node.elements.length > 0) {
            check(node.elements[0], appliedRules);
          }
        },

      labeled:      checkExpression,
      simple_and:   checkExpression,
      simple_not:   checkExpression,
      semantic_and: nop,
      semantic_not: nop,
      optional:     checkExpression,
      zero_or_more: checkExpression,
      one_or_more:  checkExpression,
      action:       checkExpression,

      rule_ref:
        function(node, appliedRules) {
          if (contains(appliedRules, node.name)) {
            throw new PEG.GrammarError(
              "Left recursion detected for rule \"" + node.name + "\"."
            );
          }
          check(ast.rules[node.name], appliedRules);
        },

      literal:      nop,
      any:          nop,
      "class":      nop
    });

    check(ast, []);
  },

  /*
   * Removes proxy rules -- that is, rules that only delegate to other rule.
   */
  removeProxyRules: function(ast) {
    function isProxyRule(node) {
      return node.type === "rule" && node.expression.type === "rule_ref";
    }

    function replaceRuleRefs(ast, from, to) {
      function nop() {}

      function replaceInExpression(node, from, to) {
        replace(node.expression, from, to);
      }

      function replaceInSubnodes(propertyName) {
        return function(node, from, to) {
          each(node[propertyName], function(subnode) {
            replace(subnode, from, to);
          });
        };
      }

      var replace = buildNodeVisitor({
        grammar:
          function(node, from, to) {
            for (var name in node.rules) {
              replace(node.rules[name], from, to);
            }
          },

        rule:         replaceInExpression,
        choice:       replaceInSubnodes("alternatives"),
        sequence:     replaceInSubnodes("elements"),
        labeled:      replaceInExpression,
        simple_and:   replaceInExpression,
        simple_not:   replaceInExpression,
        semantic_and: nop,
        semantic_not: nop,
        optional:     replaceInExpression,
        zero_or_more: replaceInExpression,
        one_or_more:  replaceInExpression,
        action:       replaceInExpression,

        rule_ref:
          function(node, from, to) {
            if (node.name === from) {
              node.name = to;
            }
          },

        literal:      nop,
        any:          nop,
        "class":      nop
      });

      replace(ast, from, to);
    }

    for (var name in ast.rules) {
      if (isProxyRule(ast.rules[name])) {
        replaceRuleRefs(ast, ast.rules[name].name, ast.rules[name].expression.name);
        if (name === ast.startRule) {
          ast.startRule = ast.rules[name].expression.name;
        }
        delete ast.rules[name];
      }
    }
  },

  /*
   * Computes names of variables used for storing match results and parse
   * positions in generated code. These variables are organized as two stacks.
   * The following will hold after running this pass:
   *
   *   * All nodes except "grammar" and "rule" nodes will have a |resultVar|
   *     property. It will contain a name of the variable that will store a
   *     match result of the expression represented by the node in generated
   *     code.
   *
   *   * Some nodes will have a |posVar| property. It will contain a name of the
   *     variable that will store a parse position in generated code.
   *
   *   * All "rule" nodes will contain |resultVars| and |posVars| properties.
   *     They will contain a list of values of |resultVar| and |posVar|
   *     properties used in rule's subnodes. (This is useful to declare
   *     variables in generated code.)
   */
  computeVarNames: function(ast) {
    function resultVar(index) { return "result" + index; }
    function posVar(index)    { return "pos"    + index; }

    function computeLeaf(node, index) {
      node.resultVar = resultVar(index.result);

      return { result: 0, pos: 0 };
    }

    function computeFromExpression(delta) {
      return function(node, index) {
        var depth = compute(
              node.expression,
              {
                result: index.result + delta.result,
                pos:    index.pos    + delta.pos
              }
            );

        node.resultVar = resultVar(index.result);
        if (delta.pos !== 0) {
          node.posVar = posVar(index.pos);
        }

        return {
          result: depth.result + delta.result,
          pos:    depth.pos    + delta.pos
        };
      };
    }

    var compute = buildNodeVisitor({
      grammar:
        function(node, index) {
          var name;

          for (name in node.rules) {
            compute(node.rules[name], index);
          }
        },

      rule:
        function(node, index) {
          var depth = compute(node.expression, index);

          node.resultVar  = resultVar(index.result);
          node.resultVars = map(range(depth.result + 1), resultVar);
          node.posVars    = map(range(depth.pos),        posVar);
        },

      choice:
        function(node, index) {
          var depths = map(node.alternatives, function(alternative) {
            return compute(alternative, index);
          });

          node.resultVar = resultVar(index.result);

          return {
            result: Math.max.apply(null, pluck(depths, "result")),
            pos:    Math.max.apply(null, pluck(depths, "pos"))
          };
        },

      sequence:
        function(node, index) {
          var depths = map(node.elements, function(element, i) {
            return compute(
              element,
              { result: index.result + i, pos: index.pos + 1 }
            );
          });

          node.resultVar = resultVar(index.result);
          node.posVar    = posVar(index.pos);

          return {
            result:
              node.elements.length > 0
                ? Math.max.apply(
                    null,
                    map(depths, function(d, i) { return i + d.result; })
                  )
                : 0,

            pos:
              node.elements.length > 0
                ? 1 + Math.max.apply(null, pluck(depths, "pos"))
                : 1
          };
        },

      labeled:      computeFromExpression({ result: 0, pos: 0 }),
      simple_and:   computeFromExpression({ result: 0, pos: 1 }),
      simple_not:   computeFromExpression({ result: 0, pos: 1 }),
      semantic_and: computeLeaf,
      semantic_not: computeLeaf,
      optional:     computeFromExpression({ result: 0, pos: 0 }),
      zero_or_more: computeFromExpression({ result: 1, pos: 0 }),
      one_or_more:  computeFromExpression({ result: 1, pos: 0 }),
      action:       computeFromExpression({ result: 0, pos: 1 }),
      rule_ref:     computeLeaf,
      literal:      computeLeaf,
      any:          computeLeaf,
      "class":      computeLeaf
    });

    compute(ast, { result: 0, pos: 0 });
  }
};
